#!/usr/bin/env python3
import json
import re
import sys
import unicodedata
from pathlib import Path

from pypdf import PdfReader


SECTION_MAP = {
    "Abluft / Wasser": "Abluft-Wasser",
    "Direktkondensation im Pufferspeicher (Sonderbauform, mit Prüfnachweis)": "Direktkondensation-Pufferspeicher",
    "Direktkondensation in der Flächenheizung (Sonderbauform)": "Direktkondensation-Flaechenheizung",
    "Direktverdampfung / Wasser": "Direktverdampfung-Wasser",
    "Luft / Luft (Heizleistung <= 12 kW)": "Luft-Luft",
    "Luft / Luft (Heizleistung > 12 kW)": "Luft-Luft",
    "Luft / Wasser": "Luft-Wasser",
    "Solar- / Luftwärmenutzung (Sonderbauform)": "Solar-Luft",
    "Solar / Wasser (Sonderbauform)": "Solar-Wasser",
    "Sole / Wasser": "Sole-Wasser",
    "Wasser / Wasser": "Wasser-Wasser",
    "sonstige Wärmequellen / Wasser": "Sonstige-Wasser",
    "VRF / Luft / Luft (Heizleistung <= 12 kW)": "VRF-Luft-Luft",
    "VRF / Luft / Luft (Heizleistung > 12 kW)": "VRF-Luft-Luft",
}

HEADER_PREFIXES = (
    "Bundesamt ",
    "Wärmepumpen mit ",
    "Seite ",
    "Report:",
    "Richtlinie ",
    "Änderungen ",
    "Die Entscheidung ",
    "Hersteller ",
    "Kältemittel ",
    "(Siehe Hinweis",
    "Verfügbarkeit",
)

HEADER_CONTAINS = (
    "Niedertemperatur-",
    "Anwendung 35",
    "Anwendung 55",
    "Nennleistung",
    "ETAs 35",
    "ETAs 55",
    "Netzdien-",
    "EE-Anzeige",
)

STATUS_VALUES = {"ja", "nein", "optional"}
NUMERIC_TOKEN = re.compile(r"^\d+,\d+$")
REFRIGERANT_TOKEN = re.compile(r"^(R[0-9A-Za-z]+|Propan|Ammoniak|CO2)$")

COMPANY_SUFFIXES = [
    " GmbH & Co. KG",
    " GmbH & Co KG",
    " GmbH",
    " AG",
    " B.V.",
    " B.V",
    " BV",
    " a.s.",
    " S.p.A.",
    " S.r.l.",
    " SAS",
    " Ltd.",
    " Ltd",
    " LLC",
    " KG",
    " AB",
    " ApS",
    " Oy",
    " Inc.",
    " Inc",
    " Co., Ltd.",
    " Co.,Ltd.",
    " Sp. z o.o.",
]

SPECIAL_MANUFACTURERS = [
    "Buderus - Bosch Thermotechnik",
    "Bosch Thermotechnik GmbH",
    "HeatPump23 GmbH",
    "Buderus",
]


def normalize_text(value: str) -> str:
    normalized = (
        unicodedata.normalize("NFD", value)
        .encode("ascii", "ignore")
        .decode("ascii")
        .lower()
    )
    return " ".join(normalized.split())


def split_prefix(prefix: str):
    for special in SPECIAL_MANUFACTURERS:
      if prefix.startswith(f"{special} "):
        return special, prefix[len(special):].strip()

    for suffix in sorted(COMPANY_SUFFIXES, key=len, reverse=True):
      idx = prefix.find(suffix)
      if idx != -1:
        cut = idx + len(suffix)
        return prefix[:cut].strip(), prefix[cut:].strip()

    parts = prefix.split()
    if len(parts) >= 2:
      second = parts[1]
      if (
        second.startswith(parts[0])
        or any(ch.isdigit() for ch in second)
        or any(ch in second for ch in "-/(")
      ):
        return parts[0], " ".join(parts[1:])

    if len(parts) >= 3:
      return " ".join(parts[:2]), " ".join(parts[2:])

    return prefix, ""


def parse_row(row: str, page_number: int, heat_pump_type: str):
    tokens = row.split()
    trailing = []

    while tokens and tokens[-1] in STATUS_VALUES:
      trailing.insert(0, tokens.pop())

    if not tokens:
      return None

    refrigerant = tokens.pop()
    if not REFRIGERANT_TOKEN.match(refrigerant):
      return None

    metrics = []
    while tokens and NUMERIC_TOKEN.match(tokens[-1]):
      metrics.insert(0, float(tokens.pop().replace(",", ".")))

    if len(metrics) not in (2, 4):
      return None

    prefix = " ".join(tokens).strip()
    manufacturer, model_name = split_prefix(prefix)

    if not manufacturer or not model_name:
      return None

    return {
      "manufacturer": manufacturer,
      "manufacturerNormalized": normalize_text(manufacturer),
      "modelName": model_name,
      "modelNameNormalized": normalize_text(model_name),
      "heatPumpType": heat_pump_type,
      "refrigerant": refrigerant,
      "availability": trailing[0] if len(trailing) >= 1 else "",
      "eeIndicator": trailing[1] if len(trailing) >= 2 else "",
      "begEligible": True,
      "maxSubsidyPct": None,
      "copA2W35": None,
      "scopRating": None,
      "pageNumber": page_number,
      "heatOutput35Kw": metrics[0],
      "etas35": metrics[1],
      "heatOutput55Kw": metrics[2] if len(metrics) == 4 else None,
      "etas55": metrics[3] if len(metrics) == 4 else None,
    }


def extract_records(pdf_path: Path):
    reader = PdfReader(str(pdf_path))
    records = []
    current_section = ""

    for page_number, page in enumerate(reader.pages, start=1):
      lines = [
        line.strip()
        for line in (page.extract_text() or "").splitlines()
        if line.strip()
      ]
      current_row = ""

      for line in lines:
        if line in SECTION_MAP:
          current_section = SECTION_MAP[line]
          current_row = ""
          continue

        if (
          line.startswith(HEADER_PREFIXES)
          or any(fragment in line for fragment in HEADER_CONTAINS)
          or line in {"KW", "%", "lichkeit"}
        ):
          continue

        if not current_section:
          continue

        current_row = f"{current_row} {line}".strip() if current_row else line

        if re.search(r"(?:ja|nein|optional)\s+(?:ja|nein|optional)\s*$", current_row):
          record = parse_row(current_row, page_number, current_section)
          if record:
            records.append(record)
          current_row = ""

    return records


def main():
    if len(sys.argv) < 2:
      raise SystemExit("Usage: extract_beg_records.py <pdf_path>")

    pdf_path = Path(sys.argv[1])
    records = extract_records(pdf_path)
    json.dump(records, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

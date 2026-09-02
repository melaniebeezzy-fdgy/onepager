#!/usr/bin/env python3
"""Reemplaza el contenido entre los marcadores de refresh en index.html SIN cargar
el archivo en el contexto del agente (ahorra tokens).

Uso:
    python tools/replace_block.py <index.html> <KEY> <block_file>

KEY = DAILY | WEEKLY | APPS | ORD  (el que corresponda a los marcadores === KEY-REFRESH START/END ===)
<block_file> = archivo de texto con SOLO el contenido nuevo que va entre los marcadores.

Imprime REPLACED / NOCHANGE / MARKERS_NOT_FOUND.
"""
import sys, re

def main():
    if len(sys.argv) != 4:
        print("USAGE: replace_block.py <index.html> <KEY> <block_file>"); sys.exit(2)
    idx, key, blockfile = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(idx, encoding='utf-8') as f:
        h = f.read()
    with open(blockfile, encoding='utf-8') as f:
        block = f.read().strip('\n')
    pat = re.compile(
        r"(/\*\s*===\s*" + re.escape(key) + r"-REFRESH START.*?\*/)\n.*?\n(/\*\s*===\s*" + re.escape(key) + r"-REFRESH END\s*===\s*\*/)",
        re.S)
    if not pat.search(h):
        print("MARKERS_NOT_FOUND"); sys.exit(1)
    h2 = pat.sub(lambda m: m.group(1) + "\n" + block + "\n" + m.group(2), h, count=1)
    with open(idx, 'w', encoding='utf-8') as f:
        f.write(h2)
    print("REPLACED" if h2 != h else "NOCHANGE")

if __name__ == "__main__":
    main()

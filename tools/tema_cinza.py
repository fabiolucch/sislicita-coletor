"""Converte o CSS do painel para o tema único em cinza intermediário (sem alternância claro/escuro).
- remove todas as regras html[data-theme="light"] (tema claro deixa de existir);
- troca cores fixas conforme a propriedade: fundos/bordas escuros → superfícies cinza; textos acinzentados → tons
  mais claros (contraste AA sobre cinza); acentos em texto → versões claras; tintas escuras → camadas translúcidas.
Uso: python3 tools/tema_cinza.py painel/theme.css painel/app.css painel/ev.css
"""
import re, sys, colorsys

def hex2rgb(h):
    h = h.lstrip('#')
    if len(h) in (3, 4): h = ''.join(c * 2 for c in h)
    a = int(h[6:8], 16) / 255 if len(h) == 8 else 1
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)), a, (h[6:8] if len(h) == 8 else '')

def lum(rgb):
    f = lambda c: c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4
    r, g, b = map(f, rgb); return .2126 * r + .7152 * g + .0722 * b

# superfícies do tema cinza
BG, SURF, RAISE, LINE, LINE2 = '#3a3e45', '#454a52', '#4f545c', '#5c626b', '#6b717a'
TXT, TXT2, MUT = '#f3f4f6', '#e5e7eb', '#cfd3d9'
KEEP_TXT = {'#18181b', '#09090b', '#000', '#000000', '#111', '#111111'}   # texto escuro sobre botões laranja
ACENTO_TXT = {'#fb923c': '#fdba74', '#f97316': '#fdba74', '#ea580c': '#fdba74', '#c2410c': '#fdba74',
              '#4ade80': '#86efac', '#22c55e': '#86efac', '#16a34a': '#86efac', '#15803d': '#86efac',
              '#fbbf24': '#fcd34d', '#f59e0b': '#fcd34d', '#d97706': '#fcd34d', '#a16207': '#fcd34d',
              '#fb7185': '#fda4af', '#f43f5e': '#fda4af', '#dc2626': '#fda4af', '#be123c': '#fda4af',
              '#60a5fa': '#93c5fd', '#2563eb': '#93c5fd', '#1d4ed8': '#93c5fd', '#a78bfa': '#c4b5fd', '#6d28d9': '#c4b5fd'}

def novo(h, prop):
    hl = h.lower()
    rgb, a, alfa = hex2rgb(hl)
    hh, ll, ss = colorsys.rgb_to_hls(*rgb)
    L = lum(rgb)
    texto = prop in ('color', 'fill', 'stroke', 'caret-color', '-webkit-text-fill-color', 'accent-color', 'text-decoration-color')
    if texto:
        if hl in KEEP_TXT: return h
        if hl in ACENTO_TXT: return ACENTO_TXT[hl] + alfa
        if ss < .18:                      # neutros
            if L < .25: return TXT + alfa  # texto escuro de tema antigo → claro
            if L < .45: return MUT + alfa
            if L < .7: return TXT2 + alfa
            return h
        if L < .35:                       # acento escuro → clareia mantendo o matiz
            r, g, b = colorsys.hls_to_rgb(hh, .78, min(1, ss))
            return '#%02x%02x%02x' % (round(r * 255), round(g * 255), round(b * 255)) + alfa
        return h
    # fundos, bordas, sombras, gradientes
    if alfa and a < .6: return h                     # sobreposições translúcidas continuam
    if ss < .18:
        if L < .012: base = BG
        elif L < .02: base = SURF
        elif L < .045: base = LINE if prop.startswith('border') or prop == 'outline' else RAISE
        elif L < .12: base = LINE2
        elif L > .8 and not prop.startswith('border'): base = SURF   # superfícies claras do layout antigo
        elif L > .8: base = LINE
        else: return h
        return base + alfa
    if L < .06:                                       # tinta escura colorida → camada translúcida do mesmo matiz
        r, g, b = colorsys.hls_to_rgb(hh, .55, min(1, ss + .3))
        return '#%02x%02x%02x33' % (round(r * 255), round(g * 255), round(b * 255))
    return h

def sem_tema_claro(css):
    """Remove regras (ou só os seletores) do tema claro, preservando @media e todo o resto do arquivo."""
    def bloco(m):
        sel, corpo = m.group(1), m.group(2)
        if 'data-theme="light"' not in sel: return m.group(0)
        partes = [s for s in sel.split(',') if 'data-theme="light"' not in s]
        return (','.join(partes) + '{' + corpo + '}') if partes else ''
    return re.sub(r'([^{}]*)\{([^{}]*)\}', bloco, css)

def converter(css):
    def decl(m):
        prop, val = m.group(1).strip().lower(), m.group(2)
        if prop.startswith('--'):            # variáveis são definidas à parte, no bloco de tokens do tema
            return m.group(0)
        return m.group(1) + ':' + re.sub(r'#[0-9a-fA-F]{3,8}\b', lambda c: novo(c.group(0), prop), val)
    return re.sub(r'([a-zA-Z-]+)\s*:([^;{}]+)', decl, css)

if __name__ == '__main__':
    for p in sys.argv[1:]:
        css = open(p, encoding='utf-8').read()
        css2 = converter(sem_tema_claro(css))
        open(p, 'w', encoding='utf-8').write(css2)
        print(p, len(css), '→', len(css2))

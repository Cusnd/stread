"""Independent inventories and long-prose retention checks for the three reviewed samples.

This checks primary HTML prose, source/asset hashes and manually selected PDF facts.
It does not certify OCR, every formula, every PDF glyph or unattended conversion.
"""
from pathlib import Path
from bs4 import BeautifulSoup, Comment
import copy, hashlib, json, re, fitz

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'evidence/conversion-contract'

def normalize(text):
    text = re.sub(r'\$[^$]*\$', '', text)
    text = re.sub(r'\[([^\[\]]+)\]\([^)]*\)', r'\1', text)
    text = text.replace('ﬁ', 'fi').replace('ﬂ', 'fl')
    return ''.join(c for c in text.casefold() if c.isalnum())

def visible(node):
    node = copy.copy(node)
    for n in node.select('math, script, style, .ltx_note_content, .ltx_note_mark, .ltx_tag_note'):
        n.decompose()
    for n in node.find_all(string=lambda value: isinstance(value, Comment)):
        n.extract()
    return node.get_text(' ', strip=True)

def output_text(blocks):
    values = []
    for b in blocks:
        for k in ['text', 'caption', 'tex', 'image_text']:
            if b.get(k): values.append(b[k])
        values += [c for field in ['head', 'rows'] for row in b.get(field, []) for c in row]
        values += [i['text'] for i in b.get('items', [])]
        if b.get('html'): values.append(BeautifulSoup(b['html'], 'html.parser').get_text(' ', strip=True))
    return normalize(' '.join(values))

checks = []
for key in ['resnet', 'mapreduce', 'crispr']:
    authored = json.loads((ROOT/'samples/conversion-contract'/f'{key}.authoring.json').read_text('utf8'))
    document = json.loads((ROOT/'public/articles'/key/'document.json').read_text('utf8'))
    report = json.loads((ROOT/'public/articles'/key/'compile-report.json').read_text('utf8'))
    source = ROOT/'public/articles'/key/'source.pdf'
    pdf = fitz.open(source)
    soup = BeautifulSoup((EVIDENCE/'inputs'/f'{key}.html').read_text('utf8'), 'html5lib')
    if key == 'resnet':
        nodes = soup.select('article p.ltx_p, article .ltx_bibblock, article figcaption, article .ltx_note_content')
    elif key == 'mapreduce':
        container = soup.find('h1').find_parent('td')
        nodes = container.select('p, dd, pre, caption')
        descendants = list(container.descendants)
        abstract = next(n for n in container.find_all('h3') if 'Abstract' in n.get_text())
        start = descendants.index(abstract)
        nodes = [n for n in nodes if descendants.index(n) > start]
    else:
        nodes = []
        for heading in soup.select('h2[id]'):
            section = heading.find_parent('div', class_='c-article-section')
            if section and heading.get('id') in ['Abs1','Sec1','Sec2','Sec3','Sec4','Sec5','Sec6','Sec7','Sec8','Sec9','Sec10','Sec11','Bib1','Ack1']:
                nodes += section.select('.c-article-section__content p')
    content = output_text(authored['blocks'])
    chunks = list(dict.fromkeys(normalize(visible(n)) for n in nodes if len(normalize(visible(n))) >= 55))
    exceptions = []
    if key == 'resnet':
        # PDF p12 explicitly says Table 4; the matching HTML aid says Table 5.
        exceptions = [c for c in chunks if '46top5classificationerrortable5' in c]
    missing = [c for c in chunks if c not in content and c not in exceptions]
    assets = []
    for name in report['assets']:
        path = ROOT/'public/articles'/key/name
        assets.append({'path':name,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    assert hashlib.sha256(source.read_bytes()).hexdigest() == authored['source']['sha256']
    assert report['result'] == 'PASS' and report['custom_css_blocks'] == 0
    checks.append({'paper':key,'pages':len(pdf),'blocks':len(document['blocks']),'types':report['types'],
                   'translated_blocks':report['translated_blocks'],'html_nodes':report['html_nodes'],
                   'internal_links':report['internal_links'],'primary_html_long_chunks':len(chunks),
                   'matched_chunks':len(chunks)-len(missing)-len(exceptions),'pdf_override_chunks':len(exceptions),
                   'unmatched_chunks':missing,'assets':assets,'warnings':report['warnings']})

# Selected facts transcribed from the rendered PDF pages, beyond structural checks.
papers = {key:json.loads((ROOT/'samples/conversion-contract'/f'{key}.authoring.json').read_text('utf8')) for key in ['resnet','mapreduce','crispr']}
mr = next(b for b in papers['mapreduce']['blocks'] if b['key']=='table-1')
assert [r[1] for r in mr['rows']] == ['29,423','634 secs','79,186 days','3,288 TB','758 TB','193 TB','157','1.2','3,351','55','395','269','426']
r14 = BeautifulSoup(next(b for b in papers['resnet']['blocks'] if b['key']=='T14')['html'],'html.parser')
assert [n.get_text(strip=True) for n in r14.select('strong')] == ['8.9','9.0']
assert len(r14.select('thead tr')) == 2 and r14.select_one('th[rowspan="2"]') and r14.select_one('th[colspan="2"]')
cr = next(b for b in papers['crispr']['blocks'] if b['key']=='Tab1')
assert len(cr['rows']) == 6 and len(cr['head'][0]) == 4 and 'Abbreviations:' in cr['caption']
result = {'result':'PASS' if all(not c['unmatched_chunks'] for c in checks) else 'REVIEW_REQUIRED',
          'scope':'Long prose from primary HTML; resource hashes; selected PDF table values. Excludes complete PDF glyph equivalence and autonomous extraction success.',
          'samples':checks,'pdf_detail_pages':{'resnet':[4,5,12],'mapreduce':[2,9,10],'crispr':[3,6]},
          'pdf_checks':['ResNet Table 1 row/column span and formulas visually compared','ResNet Table 14 merged headers, 8.9/9.0 and emphasis','MapReduce code and three labelled panels','MapReduce Table 1 all 13 values/units','CRISPR Figure 2 complete caption','CRISPR Table 1 all six rows and abbreviation footnote']}
(EVIDENCE/'content-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({**result,'samples':[{k:v for k,v in c.items() if k not in ['assets','types']} for c in checks]},ensure_ascii=False))
if result['result'] != 'PASS': raise SystemExit(1)

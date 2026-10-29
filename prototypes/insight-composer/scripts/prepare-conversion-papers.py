"""Reproducible source-specific extraction aids; output is reviewed Agent authoring input.

These adapters only extract saved primary-source HTML and verify/copy actual resources.
They are not an arbitrary-PDF parser or an autonomous model conversion benchmark.
"""
from pathlib import Path
from collections import Counter
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup, NavigableString, Tag, Comment
import copy, hashlib, html, json, re, requests, fitz, subprocess

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'evidence/conversion-contract'
INPUTS = EVIDENCE / 'inputs'
OUT = ROOT / 'public/articles'
AUTHORING = ROOT / 'samples/conversion-contract'
AUTHORING.mkdir(parents=True, exist_ok=True)
SOURCES = {
    'resnet': ('https://arxiv.org/html/1512.03385v1', 'Deep Residual Learning for Image Recognition', 'Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun', 'arXiv:1512.03385v1 · 2015'),
    'mapreduce': ('https://usenix.org/legacy/events/osdi04/tech/full_papers/dean/dean_html/index.html', 'MapReduce: Simplified Data Processing on Large Clusters', 'Jeffrey Dean, Sanjay Ghemawat', "OSDI 2004"),
    'crispr': ('https://www.nature.com/articles/emm2016111', 'Genome editing: the road of CRISPR/Cas9 from bench to clinic', 'Ayman Eid, Magdy M Mahfouz', 'Experimental & Molecular Medicine 48, e265 · 2016'),
}
SESSION = requests.Session()
asset_log = []
PDF_FIGURES = {
    'figure-1': (3, [102, 70, 515, 354]),
    'figure-2': (8, [328, 65, 525, 174]),
    'figure-3-1': (9, [72, 65, 223, 302]),
    'figure-3-2': (9, [226, 65, 377, 302]),
    'figure-3-3': (9, [380, 65, 535, 302]),
    'figure-4': (10, [338, 64, 518, 241]),
}

def clean(text):
    return re.sub(r'\s+', ' ', text).strip()

def soup_for(key, parser='html.parser'):
    return BeautifulSoup((INPUTS / f'{key}.html').read_text(encoding='utf8'), parser)

def tex_for(node):
    annotation = node.find('annotation', encoding='application/x-tex')
    return clean(annotation.get_text() if annotation else node.get('alttext', '')).replace(r'\begin{array}[]', r'\begin{array}')

def math_alt(value):
    if not (value.startswith('$') and value.endswith('$')):return None
    tex=clean(value.strip()[1:-1])
    # LaTeX2HTML writes text-mode code names as nested math dollars; preserve their text,
    # using KaTeX's supported texttt equivalent rather than leaving a broken formula.
    def nested_text(m):
        return r'\texttt{'+re.sub(r'\\mbox\{([^{}]*)\}',r'\1',m.group(1))+'}'
    tex=re.sub(r'\\mbox\{\{\\tt\$(.*?)\$\}\}',nested_text,tex,flags=re.S)
    return re.sub(r'\\mbox\{\{\\tt\s+(.*?)\}\}',lambda m:r'\texttt{'+m.group(1).replace('$','')+'}',tex,flags=re.S)

def content(node, markup=False, base=''):
    if isinstance(node, Comment): return ''
    if isinstance(node, NavigableString):
        text = re.sub(r'[\t\r\n ]+', ' ', str(node))
        text = re.sub(r'``(.*?)\x27\x27', r'“\1”', text)
        text = re.sub(r'`([^`\x27]+)\x27', r'“\1”', text)
        if not markup: text=re.sub(r'(?<!\w)_([^_\n]+)_(?!\w)',r'*\1*',text)
        return html.escape(text, quote=False) if markup else text
    if not isinstance(node, Tag): return ''
    if node.name in ['script', 'style'] or any(c in node.get('class', []) for c in ['ltx_note_mark', 'ltx_note_content']): return ''
    if node.name == 'math':
        tex = tex_for(node)
        return f'<span data-tex="{html.escape(tex, quote=True)}"></span>' if markup else '$' + tex + '$'
    if node.name == 'img':
        tex = math_alt(node.get('alt', ''))
        if tex is not None:
            return f'<span data-tex="{html.escape(tex, quote=True)}"></span>' if markup else '$' + tex + '$'
        return ''
    body = ''.join(content(c, markup, base) for c in node.children)
    # Quotes can straddle text and formula/image nodes in LaTeX2HTML output.
    if not markup: body = re.sub(r'``(.*?)\x27\x27', r'“\1”', body, flags=re.S)
    if node.name == 'br': return '<br>' if markup else '\n'
    if node.name == 'a':
        href = node.get('href', '')
        if re.match(r'^#.*\.T\d+$', href) and re.fullmatch(r'\d+', body.strip()): href = '#T' + body.strip()
        absolute=urlparse(urljoin(base,href)) if base else None
        if absolute and absolute.fragment and absolute.netloc==urlparse(base).netloc and absolute.path==urlparse(base).path:href='#'+absolute.fragment
        if href and body.strip():
            if '#' in href and (href.startswith('#') or 'emm2016111#' in href): href = '#' + href.split('#', 1)[1]
            elif not href.startswith(('http://', 'https://')): href = urljoin(base, href)
            if href.startswith(('http://', 'https://', '#')):
                return f'<a href="{html.escape(href, quote=True)}">{body}</a>' if markup else f'[{body}]({href})'
    emphasis = 'strong' if node.name in ['strong', 'b'] or 'ltx_font_bold' in node.get('class', []) else 'em' if node.name in ['em', 'i'] or 'ltx_font_italic' in node.get('class', []) else None
    if emphasis:
        return f'<{emphasis}>{body}</{emphasis}>' if markup else ('**' if emphasis == 'strong' else '*') + body + ('**' if emphasis == 'strong' else '*')
    if node.name in ['sup', 'sub']:
        if markup: return f'<{node.name}>{body}</{node.name}>'
        # References keep readable links; scientific indices retain mathematical meaning.
        if node.find('a'): return body
        return '$' + ('^' if node.name == 'sup' else '_') + '{' + body + '}$'
    if node.name in ['tt', 'code']:
        return f'<code>{body}</code>' if markup else '`' + body + '`'
    return body

def resource(key, url, name=None):
    url = urljoin(SOURCES[key][0], url)
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix not in ['.png', '.jpg', '.jpeg', '.svg', '.gif']: suffix = '.png'
    filename = (name or hashlib.sha256(url.encode()).hexdigest()[:16]) + suffix
    dest = OUT / key / 'assets' / filename
    dest.parent.mkdir(parents=True, exist_ok=True)
    if key=='mapreduce' and name in PDF_FIGURES:
        page, box = PDF_FIGURES[name]
        pdf = fitz.open(OUT/key/'source.pdf')
        pdf[page-1].get_pixmap(matrix=fitz.Matrix(4,4),clip=fitz.Rect(box),alpha=False).save(dest)
        data=dest.read_bytes()
        asset_log.append({'paper':key,'path':'assets/'+filename,'source':'source.pdf','page':page,'crop_points':box,'scale':4,'html_aid_url':url,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
        return 'assets/'+filename
    if not dest.exists():
        response = SESSION.get(url, timeout=30); response.raise_for_status(); dest.write_bytes(response.content)
    data = dest.read_bytes()
    if suffix == '.svg' and re.search(rb'<script|<foreignObject|(?:href|src)=["\x27](?:https?:|//)', data, re.I):
        raise ValueError(f'Unexpected active/external SVG content: {url}')
    asset_log.append({'paper': key, 'path': 'assets/' + filename, 'url': url, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    return 'assets/' + filename

def semantic_table(table, caption='', key='table', head_rows=1):
    rows = [row for row in table.find_all('tr') if row.find_parent('table') is table]
    actual_head=table.find('thead',recursive=False)
    if actual_head: head_rows=len(actual_head.find_all('tr',recursive=False))
    elif rows: head_rows=max(head_rows,max(int(c.get('rowspan','1')) for c in rows[0].find_all(['td','th'],recursive=False)))
    output = '<table>' + (f'<caption data-key="caption">{caption}</caption>' if caption else '')
    occupied=[set() for _ in rows]
    for group, selected in [('thead', rows[:head_rows]), ('tbody', rows[head_rows:])]:
        if not selected: continue
        output += f'<{group}>'
        for r, row in enumerate(selected):
            output += '<tr>'
            cells = row.find_all(['td', 'th'], recursive=False)
            row_index=r if group=='thead' else head_rows+r;logical_column=0
            for c, cell in enumerate(cells):
                while logical_column in occupied[row_index]: logical_column+=1
                tag = 'th' if group == 'thead' or logical_column == 0 else 'td'
                attrs = (' scope="colgroup"' if group == 'thead' and int(cell.get('colspan','1'))>1 else ' scope="col"' if group=='thead' else ' scope="row"' if logical_column == 0 else '')
                for a in ['rowspan', 'colspan']:
                    if cell.has_attr(a): attrs += f' {a}="{cell[a]}"'
                output += f'<{tag}{attrs}>' + content(cell, True, SOURCES['resnet'][0]).strip() + f'</{tag}>'
                for rr in range(row_index,min(len(rows),row_index+int(cell.get('rowspan','1')))):
                    for cc in range(logical_column,logical_column+int(cell.get('colspan','1'))):occupied[rr].add(cc)
                logical_column+=int(cell.get('colspan','1'))
            output += '</tr>'
        output += f'</{group}>'
    return output + '</table>'

def page_source(block, pdf):
    text = block.get('text') or block.get('caption') or ''
    if block['type'] == 'html': text = BeautifulSoup(block['html'], 'html.parser').get_text(' ', strip=True)
    if block['type'] == 'list': text = ' '.join(i['text'] for i in block['items'])
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    text = text.replace('ﬁ','fi').replace('ﬂ','fl')
    # Exact normalized anchor only. Unmatched positions are reported, never guessed.
    anchor = re.sub(r'[^A-Za-z0-9]', '', text).lower()
    if len(anchor) < 18: return None
    anchor = anchor[:70]
    matches = [i + 1 for i, p in enumerate(pdf) if anchor in re.sub(r'[^A-Za-z0-9]', '', p.get_text().replace('ﬁ','fi').replace('ﬂ','fl')).lower()]
    return [{'page': matches[0]}] if len(matches) == 1 else None

def resnet():
    s = soup_for('resnet'); article = s.find('article'); blocks = []; seen = set()
    def add(block):
        if block['key'] in seen: raise ValueError('duplicate ' + block['key'])
        seen.add(block['key']); blocks.append(block)
    def walk(node):
        if not isinstance(node, Tag): return
        classes = node.get('class', [])
        if node.name == 'h1' or 'ltx_authors' in classes or 'ltx_pagination' in classes: return
        if node.name in ['h2', 'h3', 'h4', 'h5', 'h6']:
            text = clean(content(node)); key = node.parent.get('id') or f'heading-{len(blocks)}'
            m = re.match(r'^(\d+(?:\.\d+)*)\s+(.+)$', text)
            add({'key': key, 'type': 'heading', 'level': max(1, int(node.name[1]) - 1), 'text': m.group(2) if m else text, **({'num': m.group(1)} if m else {})}); return
        if node.name == 'figure':
            key = node['id']; cap = content(node.find('figcaption')).strip(); number = re.search(r'(?:Table|Figure)\s*(\d+)', cap).group(1)
            if 'ltx_table' in classes:
                tables = [t for t in node.find_all('table') if not t.find_parent('table')]; captions = node.find_all('figcaption')
                if len(tables) != len(captions): raise ValueError('Table/caption pairing must be reviewed: '+key)
                for table, caption in zip(tables,captions):
                    number = re.search(r'Table\s*(\d+)',caption.get_text(' ',strip=True)).group(1); key='T'+number
                    if table.find(attrs={'colspan':True}) or table.find(attrs={'rowspan':True}) or number=='6':
                        markup=semantic_table(table,content(caption,True).strip(),key)
                        add({'key':key,'type':'html','role':'table','num':number,'html':markup})
                    else:
                        rows=[[content(c).strip() for c in tr.find_all(['th','td'],recursive=False)] for tr in table.find_all('tr') if tr.find_parent('table') is table]
                        heads=2 if number=='7' else 1
                        add({'key':key,'type':'table','num':number,'head':rows[:heads],'rows':rows[heads:],'caption':content(caption).strip()})
            else:
                graphics = node.find_all('object', class_='ltx_graphics')
                if len(graphics) != 1: raise ValueError(f'Figure {key} has {len(graphics)} graphics')
                obj = graphics[0]; src = resource('resnet', obj['data'], 'figure-' + number)
                add({'key': key, 'type': 'figure', 'num': number, 'src': src, 'alt': clean(BeautifulSoup(cap, 'html.parser').get_text()), 'caption': cap,
                     'extensions': {'continous-reader.image-size': {'width': int(obj['width']), 'height': int(obj['height'])}}})
            return
        if 'ltx_equation' in classes and node.get('id'):
            maths = node.find_all('math'); tex = ' \\quad '.join(tex_for(m) for m in maths)
            tag = node.find(class_='ltx_tag_equation')
            add({'key': node['id'], 'type': 'math', 'tex': tex, 'tag': tag.get_text(strip=True).strip('()') if tag else ''}); return
        if 'ltx_bibitem' in classes:
            pieces = node.find_all(class_='ltx_bibblock'); text = ' '.join(clean(content(p)) for p in pieces)
            tag = node.find(class_='ltx_tag_bibitem')
            add({'key': node['id'], 'type': 'para', 'role': 'reference', 'text': (tag.get_text() + ' ' if tag else '') + text}); return
        if node.name == 'p' and 'ltx_p' in classes:
            text = content(node).strip()
            if text: add({'key': node.get('id') or f'p-{len(blocks)}', 'type': 'para', 'text': text})
            for foot in node.select('.ltx_note_content'):
                number=foot.find(class_='ltx_tag_note').get_text(strip=True)
                body=''.join(content(c) for c in foot.children if not isinstance(c,Tag) or 'ltx_tag_note' not in c.get('class',[]))
                add({'key': foot.get('id') or f'footnote-{len(blocks)}', 'type': 'para', 'role': 'footnote', 'num':number, 'text': clean(body)})
            return
        for child in node.children: walk(child)
    walk(article)
    return blocks

def mapreduce():
    s = soup_for('mapreduce', 'html5lib'); container = s.find('h1').find_parent('td'); blocks = []; counter = Counter(); active = False
    aliases={}
    for heading in container.find_all(['h1','h2','h3','h4']):
        anchors=[a.get('id') or a.get('name') for a in heading.find_all('a') if a.get('id') or a.get('name')]
        for anchor in anchors[1:]:aliases[anchor]=anchors[0]
    for caption in container.find_all('caption'):
        match=re.match(r'(Figure|Table)\s+(\d+)',caption.get_text(' ',strip=True))
        if match:
            table=caption.find_parent('table'); parent=table.parent
            for anchor in parent.find_all('a',attrs={'name':True},recursive=False):aliases[anchor['name']]=match.group(1).lower()+'-'+match.group(2)
    aliases['mapreduce-august-2004']='table-1'
    def add(kind, data, key=None):
        counter[kind] += 1
        if not key and kind=='para':key='p-'+hashlib.sha256(data['text'].encode()).hexdigest()[:16]
        blocks.append({'key': key or f'{kind}-{counter[kind]}', 'type': kind, **data})
    def children(parent):
        buffer=[]
        def flush():
            if active and buffer:
                text=''.join(content(n,base=SOURCES['mapreduce'][0]) for n in buffer).strip()
                if text:add('para',{'text':text})
            buffer.clear()
        for child in parent.children:
            if isinstance(child,NavigableString) or (isinstance(child,Tag) and child.name in ['a','em','i','b','strong','span','tt','code','img','br']):buffer.append(child)
            else:flush();process(child)
        flush()
    def process(node):
        nonlocal active
        if not isinstance(node, Tag): return
        if node.name == 'h3' and 'Abstract' in node.get_text(): active = True
        if not active: return
        if node.name in ['h1', 'h2', 'h3', 'h4']:
            text = clean(node.get_text()); anchor = node.find('a'); key = anchor.get('id') or anchor.get('name') if anchor else None
            num = re.match(r'^(\d+(?:\.\d+)*)\s+(.*)$', text)
            add('heading', {'level': 1 if text.rstrip(':') in ['Abstract','Bibliography'] else min(3, int(node.name[1])), 'text': num.group(2) if num else text.rstrip(':'), **({'num': num.group(1)} if num else {})}, key); return
        if node.name == 'pre':
            add('html', {'role': 'code', 'html': '<pre><code>' + html.escape(node.get_text()) + '</code></pre>'}); return
        if node.name == 'dl':
            terms = node.find_all(['dt','dd'], recursive=False); label = ''; refkey=None
            for term in terms:
                if term.name == 'dt':
                    label = clean(term.get_text()); anchor=term.find('a');refkey=anchor.get('name') if anchor else None;continue
                text=clean(content(term,base=SOURCES['mapreduce'][0]))
                if text: add('para', {'role': 'reference', 'text': label + ' ' + text}, refkey or f'ref-{label}')
            return
        if node.name in ['ol','ul']:
            items = [{'key': f'item-{i+1}', 'text': content(li, base=SOURCES['mapreduce'][0]).strip()} for i, li in enumerate(node.find_all('li', recursive=False))]
            add('list', {'ordered': node.name == 'ol', 'items': items}); return
        if node.name == 'table':
            text = clean(node.get_text(' ', strip=True))
            if text.startswith('Figure'):
                number = re.match(r'Figure\s+(\d+)', text).group(1)
                images = [i for i in node.find_all('img') if math_alt(i.get('alt','')) is None and any(v in i.get('alt','') for v in ['figure','epsfig','epsfbox'])]
                if number == '3':
                    if len(images) != 3: raise ValueError('MapReduce Figure 3 requires three original panels')
                    captions = ['(a) Normal execution', '(b) No backup tasks', '(c) 200 tasks killed']
                    inner = ''.join(f'<figure><img src="{resource("mapreduce",im["src"],f"figure-3-{i+1}")}" alt="{captions[i]}"><figcaption>{captions[i]}</figcaption></figure>' for i,im in enumerate(images))
                    add('html', {'role':'figure','num':number,'html':'<figure><figcaption data-key="caption">Figure 3: Data transfer rates over time for different executions of the sort program</figcaption><div class="layout-grid">'+inner+'</div></figure>'}, 'figure-3')
                else:
                    if len(images) != 1: raise ValueError(f'MapReduce figure {number}: {len(images)} images')
                    src = resource('mapreduce',images[0]['src'],'figure-'+number)
                    add('figure',{'num':number,'src':src,'alt':text,'caption':text},'figure-'+number)
                return
            if text.startswith('Table 1'):
                table=node.find('table'); rows=[]
                for tr in table.find_all('tr'):
                    cells=[clean(content(c,base=SOURCES['mapreduce'][0])) for c in tr.find_all('td',recursive=False)]
                    if cells: rows.append([cells[0], ' '.join(v for v in cells[1:] if v)])
                add('table',{'num':'1','caption':'Table 1: MapReduce jobs run in August 2004','head':[], 'rows':rows},'table-1'); return
            # The two-row function type declaration is a semantic definition list.
            if 'map' in text and 'reduce' in text:
                rows=[]
                for tr in node.find_all('tr'):
                    cells=tr.find_all('td',recursive=False)
                    if cells: rows.append('<p>'+ ' '.join(content(c,True,SOURCES['mapreduce'][0]).strip() for c in cells)+'</p>')
                add('html',{'role':'algorithm','html':'<div class="layout-stack">'+''.join(rows)+'</div>'},'function-types'); return
            raise ValueError('Unclassified MapReduce table '+text[:90])
        if node.name == 'p':
            # html5lib closes old unclosed paragraphs. Structural children are handled independently.
            if node.find(['table','pre','ol','ul'], recursive=False):
                children(node)
            else:
                text=content(node,base=SOURCES['mapreduce'][0]).strip()
                if text: add('para',{'text':text})
            return
        if node.name == 'div' and node.get('align') == 'CENTER':
            children(node)
            return
        if node.name == 'div' and node.get('class') == ['ABSTRACT']:
            add('para',{'role':'abstract','text':content(node,base=SOURCES['mapreduce'][0]).strip()}); return
        children(node)
    children(container)
    def links(value):
        if isinstance(value,str):return re.sub(r'\]\(#([^\)]+)\)',lambda m:'](#'+aliases.get(m.group(1),m.group(1))+')',value)
        if isinstance(value,list):return [links(v) for v in value]
        if isinstance(value,dict):return {k:links(v) if k!='key' else v for k,v in value.items()}
        return value
    blocks=links(blocks)
    return blocks

def crispr():
    s=soup_for('crispr'); blocks=[]
    for section_id in ['Abs1']+[f'Sec{i}' for i in range(1,13)]+['Bib1','Ack1']:
        heading=s.find(id=section_id)
        if not heading: continue
        blocks.append({'key':section_id,'type':'heading','level':1,'text':clean(heading.get_text())})
        section=heading.find_parent('div',class_='c-article-section'); content_root=section.find(class_='c-article-section__content')
        if section_id=='Bib1':
            for li in section.select('li.c-article-references__item'):
                p=li.find('p'); blocks.append({'key':p.get('id'),'type':'para','role':'reference','text':li.get('data-counter','')+' '+clean(content(p,base=SOURCES['crispr'][0]))})
            continue
        for i,node in enumerate(content_root.children):
            if not isinstance(node,Tag):continue
            if node.name=='p':
                blocks.append({'key':f'{section_id}-p{i}','type':'para','text':content(node,base=SOURCES['crispr'][0]).strip()});continue
            figure=node if node.name=='figure' else node.find('figure')
            if not figure: continue
            label=figure.find('figcaption').get_text(' ',strip=True);num=re.search(r'\d+',label).group(0)
            if label.startswith('Table'):
                ts=BeautifulSoup((INPUTS/'crispr-table1.html').read_text(encoding='utf8'),'html.parser');table=ts.find('table')
                head=[[clean(content(c,base=SOURCES['crispr'][0])) for c in tr.find_all(['th','td'],recursive=False)] for tr in table.thead.find_all('tr')]
                rows=[[clean(content(c,base=SOURCES['crispr'][0])) for c in tr.find_all(['th','td'],recursive=False)] for tr in table.tbody.find_all('tr')]
                footer=ts.select_one('.c-article-table-footer,.c-article-table__footer,.c-article-table__footnotes')
                caption='Systematic comparison of the ZFN, TALEN and CRISPR/Cas9 genome-engineering platforms'
                if footer:caption+='\n\n'+clean(content(footer,base=SOURCES['crispr'][0]))
                blocks.append({'key':'Tab1','type':'table','num':'1','caption':caption,'head':head,'rows':rows});continue
            im=figure.find('img');src=resource('crispr',im['src'],'figure-'+num)
            desc=figure.find(class_='c-article-section__figure-description')
            if not desc: desc=figure.find(id=f'figure-{num}-desc')
            paragraphs=desc.find_all('p') if desc else []
            cap='\n'.join(content(p,base=SOURCES['crispr'][0]).strip() for p in paragraphs)
            if not cap: raise ValueError('Missing caption '+label)
            if num=='2':
                blocks.append({'key':'Fig2','type':'html','role':'figure','num':'2','html':f'<figure class="layout-stack"><img src="{src}" alt="{html.escape(label)}"><figcaption data-key="caption">'+''.join(content(p,True,SOURCES['crispr'][0]) for p in paragraphs)+'</figcaption></figure>'})
            else:blocks.append({'key':'Fig'+num,'type':'figure','num':num,'src':src,'alt':label,'caption':cap})
    # Non-body source statements retained separately, excluding the website's related-article widgets.
    for name,heading_id in [('ethics','ethics'),('rights','rightslink')]:
        h=s.find(id=heading_id)
        if h:
            sec=h.find_parent('div',class_='c-article-section')
            if sec:
                for i,p in enumerate(sec.select('.c-article-section__content p')):
                    blocks.append({'key':f'{name}-{i}','type':'para','role':name,'text':content(p,base=SOURCES['crispr'][0]).strip()})
    return blocks

def build():
    reports=[]
    translations=json.loads((AUTHORING/'reviewed-translations.json').read_text(encoding='utf8'))
    for key,adapter in [('resnet',resnet),('mapreduce',mapreduce),('crispr',crispr)]:
        blocks=adapter();pdf=fitz.open(OUT/key/'source.pdf');unmatched=[]
        for block in blocks:
            # These differences were checked against the PDF, not copied from HTML counters.
            if key=='resnet' and block['key']=='A3.p4.1':
                block['text']=block['text'].replace('4.6% top-5 classification error, Table [5](#T5)', '4.6% top-5 classification error, Table [4](#T4)')
            if key=='mapreduce' and block['type']=='heading':
                if block.get('num','').startswith('2.3.0.'):
                    block.pop('num');block['text']=block['text'].rstrip(':')
                if block.get('num')=='9':block['num']='A'
                if block['text']=='Bibliography':block['text']='References'
            review=translations.get(key,{}).get(block['key'])
            if review:
                if block['type']=='html':
                    translated=BeautifulSoup(block['html'],'html.parser')
                    for text_node in list(translated.find_all(string=True)):
                        value=str(text_node)
                        for original,replacement in review.get('replace',{}).items():value=value.replace(original,replacement)
                        if value!=str(text_node):text_node.replace_with(value)
                    if 'captions' in review:
                        caps=translated.find_all(['caption','figcaption'])
                        if len(caps)!=len(review['captions']):raise ValueError('Translation caption mismatch '+key+':'+block['key'])
                        for node,value in zip(caps,review['captions']):node.clear();node.append(value)
                    block['translations']={'zh-CN':{'html':str(translated),'alignment':'same-structure'}}
                else:
                    payload={k:v for k,v in review.items() if k in ['caption','head','rows','text']}
                    if 'row_labels' in review:
                        if len(review['row_labels'])!=len(block['rows']):raise ValueError('Translation row mismatch')
                        payload['head']=copy.deepcopy(block['head']);payload['rows']=copy.deepcopy(block['rows'])
                        for row,label in zip(payload['rows'],review['row_labels']):row[0]=label
                    block['translations']={'zh-CN':payload}
            source=page_source(block,pdf)
            if source:block['source']=source
            else:unmatched.append(block['key'])
        url,title,authors,publication=SOURCES[key]
        document={'format':'reader-authoring-1','key':key,'meta':{'title':title,'language':'en','authors':authors},
                  'source':{'path':'source.pdf','sha256':hashlib.sha256((OUT/key/'source.pdf').read_bytes()).hexdigest(),'pages':len(pdf)},'blocks':blocks,
                  'extensions':{'continous-reader.presentation':{'publication':publication,'source_note':f'{len(pdf)} 页原稿 · 重点结构含示例译文，其余保留原文','translation_note':'本样本用于验证转换约定。原文全文转换；仅重点结构提供人工核对的中文译文。'},
                                'continous-reader.conversion':{'html_aid':url,'source_role':'Primary-source HTML extraction aid; PDF retained for checks','coverage':'full source article including references and available appendices; selective translation','unmatched_page_keys':unmatched}}}
        if key=='resnet':
            document['extensions']['continous-reader.presentation']['translation_note']+=' PDF 第 12 页正文引用 Table 4，辅助 HTML 写为 Table 5；此处遵照 PDF 保留 Table 4，未替作者纠错。'
        (AUTHORING/f'{key}.authoring.json').write_text(json.dumps(document,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        reports.append({'paper':key,'pages':len(pdf),'blocks':len(blocks),'types':dict(Counter(b['type'] for b in blocks)),'page_anchor_matched':len(blocks)-len(unmatched),'unmatched':unmatched})
    (EVIDENCE/'extraction-report.json').write_text(json.dumps({'samples':reports,'assets':asset_log},ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps(reports,ensure_ascii=False))

if __name__=='__main__':build()

"""Read-only огляд production. Знімки приватні; не копіювати в docs/img без очищення.

Жодних змін джерел, прав, користувачів або даних. Єдиний POST — власний вхід.
Для публічної документації використовувати check_dashboard_browser.mjs із синтетикою.
"""
import json
import os
from pathlib import Path

import httpx
from playwright.sync_api import sync_playwright

ORIGIN = 'https://hire.qpon'
OUT = Path(os.environ.get('UFV_SCREENSHOTS', 'artifacts/night-full-review'))
PAGES = [
    ('dashboard', '/'), ('dashboard-week', '/?window=7d'), ('dashboard-month', '/?window=30d'),
    ('feed', '/feed'), ('inbox', '/inbox'), ('analysis', '/analysis'), ('sources', '/sources'),
    *[(f'telegram-{tab}', f'/sources/telegram?tab={tab}') for tab in
      ['accounts', 'channels', 'bulk', 'watch', 'workflows', 'shares', 'operations']],
    ('rss', '/sources/rss'), ('users', '/admin/users'), ('account', '/account'),
    ('login', '/login'), ('shared-invalid', '/view'), ('showcase', '/showcase/'),
]
CHECK = """() => {
 const issues=[],vw=document.documentElement.clientWidth;
 if(document.documentElement.scrollWidth>vw+1)issues.push('document overflow');
 for(const e of document.querySelectorAll('body *')){
  const r=e.getBoundingClientRect(),s=getComputedStyle(e);
  if(!r.width||!r.height||s.visibility==='hidden'||e.closest('svg,dialog:not([open])'))continue;
  const scroll=e.closest('.tabs,.tablewrap,.cmd,.sidebar,.slot-contract,.ai-source-list');
  const name=e.tagName+(typeof e.className==='string'?'.'+e.className:'');
  if(!scroll&&(r.left<-1||r.right>vw+1))issues.push('overflow '+name);
  if(e.matches('button,input,select,textarea,summary,a.btn,[role=switch]')&&!e.matches('.scrim')&&r.height<32
    &&!(e.matches('input[type=checkbox]')&&e.closest('label')?.getBoundingClientRect().height>=32))issues.push('small target '+name);
 }
 return [...new Set(issues)];
}"""


def main():
    os.umask(0o077)
    OUT.mkdir(parents=True, exist_ok=True)
    password = Path('/etc/ufv/admin-bootstrap.txt').read_text().split('Password: ', 1)[1].strip()
    with httpx.Client(base_url=ORIGIN, headers={'Origin': ORIGIN}, timeout=30) as client:
        response = client.post('/api/auth/sign-in/email', json={'email': 'admin@hire.qpon', 'password': password})
        if response.status_code != 200:
            raise RuntimeError('review_login_failed')
        cookies = [{'name': c.name, 'value': c.value, 'url': ORIGIN} for c in client.cookies.jar]
    del password
    report = []
    selected = os.environ.get('UFV_PAGE')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for width in [1440, 390]:
            for theme in ['light', 'dark']:
                for name, path in PAGES:
                    if selected and name != selected:
                        continue
                    context = browser.new_context(viewport={'width': width, 'height': 900}, color_scheme=theme,
                                                  locale='uk-UA', timezone_id='Europe/Kyiv')
                    if name not in ['login', 'shared-invalid', 'showcase']:
                        context.add_cookies(cookies)
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda e: errors.append(type(e).__name__))
                    page.on('response', lambda response: errors.append('server error ' + str(response.status))
                            if response.status >= 500 and response.url.startswith(ORIGIN + '/api/') else None)
                    try:
                        response = page.goto(ORIGIN + path, wait_until='networkidle', timeout=45000)
                        if not response or response.status != 200:
                            errors.append('route status')
                        page.evaluate('document.fonts.ready')
                        issues = page.evaluate(CHECK)
                        height = page.evaluate('document.documentElement.scrollHeight')
                        # Very tall images become unreadable in the review viewer.
                        # Keep top/middle/bottom at real viewport size for long lists.
                        page.screenshot(path=str(OUT / f'{name}-{width}-{theme}.png'), full_page=height <= 3000)
                        if height > 3000:
                            for position in ['middle', 'bottom']:
                                page.evaluate('(y)=>window.scrollTo(0,y)', height // 2 if position == 'middle' else height)
                                page.screenshot(path=str(OUT / f'{name}-{position}-{width}-{theme}.png'))
                    except Exception as error:
                        issues = [type(error).__name__]
                    result = {'page': name, 'width': width, 'theme': theme, 'issues': issues + errors}
                    report.append(result)
                    print(json.dumps(result, ensure_ascii=False), flush=True)
                    context.close()
        browser.close()
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    if any(item['issues'] for item in report):
        raise SystemExit(1)


if __name__ == '__main__':
    main()

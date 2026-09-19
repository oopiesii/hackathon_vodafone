"""Перевірений нічний реліз; стан і rollback images зберігаються поза Git."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
STATE = Path('/var/lib/ufv/releases')
COMPOSE = ['docker','compose','--env-file','/etc/ufv/production.env','-f',str(ROOT/'deploy/compose.yml')]
IMAGES = {'api':('ufv-api','deploy/Dockerfile.node'),'processor':('ufv-pipeline','deploy/Dockerfile.pipeline'),'collector':('ufv-pipeline','deploy/Dockerfile.pipeline'),'collector-rss':('ufv-pipeline','deploy/Dockerfile.pipeline'),'analyst':('ufv-analyst','deploy/Dockerfile.analyst')}

def run(args, **kwargs):
    return subprocess.run(args,cwd=ROOT,check=True,**kwargs)

def capture(args):
    return subprocess.check_output(args,cwd=ROOT,text=True).strip()

def running(service):
    result=subprocess.run(['docker','inspect',f'ufv-{service}-1','--format','{{.Image}}'],text=True,capture_output=True)
    return result.stdout.strip() if result.returncode==0 else None

def save(path, data):
    temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data,indent=2)+'\n');temporary.chmod(0o600);temporary.replace(path)

def checks(browser=True):
    import httpx
    with httpx.Client(timeout=30,follow_redirects=True) as client:
        for path in ['/api/health','/','/inbox','/showcase/']:
            response=client.get('https://hire.qpon'+path)
            if response.status_code!=200: raise RuntimeError('public_check_'+path)
        if client.get('https://hire.qpon/api/feed').status_code!=401: raise RuntimeError('anonymous_feed_boundary')
        if client.get('https://h1hs.com/api/health').status_code!=200: raise RuntimeError('neighbor_health')
        print('Публічні маршрути, health, сусідній сервіс: OK',flush=True)
        password=Path('/etc/ufv/admin-bootstrap.txt').read_text().split('Password: ',1)[1].strip()
        client.headers['Origin']='https://hire.qpon'
        response=client.post('https://hire.qpon/api/auth/sign-in/email',json={'email':'admin@hire.qpon','password':password})
        if response.status_code!=200: raise RuntimeError('admin_login_check')
        for path in ['/api/me','/api/inbox','/api/dashboard?workflow_id=1&window=24h']:
            if client.get('https://hire.qpon'+path).status_code!=200: raise RuntimeError('authenticated_check_'+path)
        if browser:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
                context=browser.new_context(viewport={'width':1440,'height':900},locale='uk-UA',timezone_id='Europe/Kyiv')
                context.add_cookies([{'name':c.name,'value':c.value,'url':'https://hire.qpon'} for c in client.cookies.jar])
                page=context.new_page();errors=[]
                page.on('pageerror',lambda error:errors.append(type(error).__name__))
                for path in ['/','/feed','/inbox','/showcase/']:
                    response=page.goto('https://hire.qpon'+path,wait_until='networkidle')
                    if not response or response.status!=200:raise RuntimeError('browser_route_'+path)
                    if path=='/':page.get_by_role('heading',name='Сьогодні',exact=True).wait_for()
                    if path=='/inbox':page.get_by_role('heading',name='Увесь вхід',exact=True).wait_for()
                if errors:raise RuntimeError('browser_javascript_errors')
                browser.close()
        print('Вхід, dashboard, inbox і Chromium: OK',flush=True)

def switch(images, stamp):
    override=STATE/(stamp+'-compose.json')
    save(override,{'services':{service:{'image':image} for service,image in images.items()}})
    run(COMPOSE+['-f',str(override),'up','-d','--no-deps','--no-build',*images])

def rollback(manifest, manifest_path):
    previous={service:item['rollback'] for service,item in manifest['services'].items() if item['rollback']}
    new=[service for service,item in manifest['services'].items() if not item['rollback']]
    if previous:switch(previous,manifest['stamp']+'-rollback')
    if new:run(COMPOSE+['stop',*new])
    for service,item in manifest['services'].items():
        if item['rollback']:run(['docker','tag',item['rollback'],IMAGES[service][0]+':local'])
    manifest['status']='rolled_back';manifest['rolled_back_at']=datetime.now(timezone.utc).isoformat();save(manifest_path,manifest)
    # A pre-night API may not yet have dashboard. Its original health still must recover.
    import httpx
    for attempt in range(20):
        try:
            if httpx.get('https://hire.qpon/api/health',timeout=10).status_code==200:
                if httpx.get('https://h1hs.com/api/health',timeout=10).status_code!=200:raise RuntimeError('neighbor_failed_after_rollback')
                print('Відкат: API та сусідній сервіс здорові.',flush=True);return
        except httpx.HTTPError:pass
        time.sleep(2)
    manifest['status']='rollback_failed';save(manifest_path,manifest);raise RuntimeError('rollback_failed_stop_all_work')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--services',nargs='+',choices=IMAGES,default=['api']);parser.add_argument('--rollback',type=Path);parser.add_argument('--check-only',action='store_true');args=parser.parse_args()
    if os.geteuid()!=0:raise RuntimeError('root_required_for_protected_runtime_files')
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    lock=(STATE/'release.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if args.check_only:checks();return
    if args.rollback:
        manifest=json.loads(args.rollback.read_text());rollback(manifest,args.rollback);return
    collectors=set(args.services)&{'collector','collector-rss'}
    if collectors:
        now=datetime.now(ZoneInfo('Europe/Kyiv'))
        if now >= datetime(2026,9,20,4,45,tzinfo=ZoneInfo('Europe/Kyiv')):raise RuntimeError('collector_restart_window_closed')
        for path in STATE.glob('night-*.json'):
            state=json.loads(path.read_text())
            if state.get('collectors_restarted'):raise RuntimeError('night_collector_restart_already_used')
    stamp='night-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ');path=STATE/(stamp+'.json')
    manifest={'stamp':stamp,'status':'building','git_head':capture(['git','rev-parse','HEAD']),'services':{},'collectors_restarted':False}
    built={}
    for service in args.services:
        image,dockerfile=IMAGES[service];old=running(service)
        oldtag=f'{image}:pre-{stamp}-{service}' if old else None
        if oldtag:run(['docker','tag',old,oldtag])
        candidate=f'{image}:{stamp}'
        manifest['services'][service]={'before':old,'rollback':oldtag,'candidate':candidate}
        built[candidate]=dockerfile
    save(path,manifest)
    for candidate,dockerfile in built.items():run(['docker','build','-f',dockerfile,'-t',candidate,'.'])
    # Адитивні міграції не відкочуються: попередні images лишаються сумісними.
    run([sys.executable,'deploy/bootstrap.py'])
    for service,item in manifest['services'].items():
        if running(service)!=item['before']:raise RuntimeError('parallel_deployment_detected_before_switch')
    switched=False
    try:
        switched=True
        if collectors:manifest['collectors_restarted']=True;save(path,manifest)
        switch({s:i['candidate'] for s,i in manifest['services'].items()},stamp)
        import httpx
        for attempt in range(30):
            try:
                if httpx.get('https://hire.qpon/api/health',timeout=5).status_code==200:break
            except httpx.HTTPError:pass
            time.sleep(2)
        checks()
        for service,item in manifest['services'].items():run(['docker','tag',item['candidate'],IMAGES[service][0]+':local'])
        manifest['status']='verified';manifest['verified_at']=datetime.now(timezone.utc).isoformat();save(path,manifest)
        print('Розгорнуто й перевірено. Маніфест:',path,flush=True)
        print('Відкат: deploy/night-release.sh --rollback '+str(path),flush=True)
    except BaseException:
        if switched:rollback(manifest,path)
        raise

if __name__=='__main__':
    try:main()
    except Exception as error:
        # Не друкуємо response bodies, credentials або з'єднання БД.
        print('Реліз завершився помилкою:',str(error) if isinstance(error,RuntimeError) else type(error).__name__,file=sys.stderr)
        sys.exit(1)

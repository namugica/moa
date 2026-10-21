"""OAuth/account UI + real local PostgreSQL RPC. No live Supabase data is used.
OAuth provider responses are simulated; real Google/Kakao credentials are external.
"""
import json
import os
from pathlib import Path
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
CONTAINER = os.environ.get('MOA_TEST_CONTAINER', 'moa-supabase-check')
USERS = {name: f'00000000-0000-0000-0000-{index:012d}' for index, name in enumerate(['owner','friend','outsider'], 1)}

def query(sql):
    result = subprocess.run(['docker','exec',CONTAINER,'psql','-U','postgres','-qAt','-v','ON_ERROR_STOP=1','-c',sql], check=True, capture_output=True, text=True)
    return result.stdout

for uid in USERS.values():
    query(f"insert into auth.users(id) values('{uid}') on conflict do nothing")

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,*args): pass

def setup_routes(context, identity):
    uid = USERS[identity]
    user = {'id':uid,'user_metadata':{},'identities':[{'provider':'google' if identity=='owner' else 'kakao'}]}
    tokens = {'access_token':f'test-access-{uid}','refresh_token':f'test-refresh-{uid}','expires_in':3600,'user':user}
    def route_request(route):
        req=route.request
        cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'apikey,authorization,content-type','Content-Type':'application/json'}
        if req.method=='OPTIONS': route.fulfill(status=204,headers=cors);return
        path=urlparse(req.url).path
        if path.endswith('/settings'): result={'external':{'google':True,'kakao':True}}
        elif path.endswith('/authorize'):
            args=parse_qs(urlparse(req.url).query)
            assert args['provider'][0] in ['google','kakao'] and args['code_challenge_method'][0]=='s256'
            route.fulfill(status=302,headers={'Location':args['redirect_to'][0]+'?code='+identity+'-test-code'});return
        elif path.endswith('/token'):
            assert req.post_data_json.get('code_verifier') or req.post_data_json.get('refresh_token')
            result=tokens
        elif path.endswith('/user'): result=user
        elif path.endswith('/logout'): route.fulfill(status=204,headers=cors);return
        elif '/rpc/' in path:
            assert req.headers.get('apikey','').startswith('sb_publishable_')
            bearer=req.headers.get('authorization')
            claims=json.dumps({'sub':uid}) if bearer=='Bearer '+tokens['access_token'] else '{}'
            role='authenticated' if claims!='{}' else 'anon'
            raw=json.dumps(req.post_data_json,ensure_ascii=False).replace("'","''")
            function='moa_account_api' if path.endswith('moa_account_api') else 'moa_api'
            sql=f"""begin;set local role {role};
            select set_config('request.jwt.claims','{claims}',true);
            with args as (select '{raw}'::jsonb j)
            select public.{function}(j->>'action',(j->>'trip_id')::uuid,j->>'session_token',j->>'invite_token',coalesce(j->'payload','{{}}'::jsonb)) from args;
            commit;"""
            output=query(sql).strip().splitlines()
            result=json.loads(output[-1])
        else: raise AssertionError('Unexpected mocked endpoint')
        route.fulfill(status=200,headers=cors,body=json.dumps(result))
    context.route('https://*.supabase.co/**',route_request)

server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        contexts=[browser.new_context() for _ in range(3)]
        for context,identity in zip(contexts,['owner','friend','outsider']): setup_routes(context,identity)
        owner,friend,outsider=[context.new_page() for context in contexts]
        errors=[]
        for page in [owner,friend,outsider]: page.on('pageerror',lambda error:errors.append(str(error)))
        def login(page,provider,name):
            page.get_by_role('button',name=f'{provider}로 계속하기',exact=True).click()
            page.get_by_role('heading',name='내 프로필 설정',exact=True).wait_for()
            page.locator('[name="profileName"]').fill(name)
            page.get_by_role('button',name='저장하기',exact=True).click()
            expect(page.locator('#editor')).not_to_be_visible()
        owner.goto(base)
        owner.get_by_role('button',name='로그인',exact=True).click()
        login(owner,'구글','지우')
        owner.locator('[data-action="create-trip"]').first.click()
        for name,value in [('title','로그인 공유 여행'),('destination','제주'),('start','2026-11-01'),('end','2026-11-02')]: owner.locator(f'[name="{name}"]').fill(value)
        owner.get_by_role('button',name='저장하기',exact=True).click()
        owner.get_by_role('button',name='친구 초대',exact=True).click()
        owner.get_by_role('button',name='저장하기',exact=True).click()
        owner.locator('[name="inviteLink"]').wait_for()
        link=owner.locator('[name="inviteLink"]').input_value()
        owner.get_by_role('button',name='닫기',exact=True).click()
        friend.goto(link)
        login(friend,'카카오','민지')
        friend.get_by_role('button',name='초대 수락하고 참여하기',exact=True).click()
        expect(friend.locator('.personal-settlement .eyebrow')).to_have_text('민지님의 정산')
        expect(owner.locator('.member')).to_have_count(2)
        owner.locator('[data-action="create-expense"]').first.click()
        owner.locator('[name="title"]').fill('함께 먹은 점심');owner.locator('[name="amount"]').fill('10001')
        owner.get_by_role('button',name='저장하기',exact=True).click()
        expect(owner.locator('[data-personal-balance]')).to_have_attribute('data-personal-balance','5000')
        expect(friend.locator('[data-personal-balance]')).to_have_attribute('data-personal-balance','-5000')
        expect(friend.locator('.expense-row')).to_contain_text('함께 먹은 점심')
        # Same invitation is reusable by a different authenticated account.
        outsider.goto(link);login(outsider,'카카오','민지')
        outsider.get_by_role('button',name='초대 수락하고 참여하기',exact=True).click()
        expect(owner.locator('.member')).to_have_count(3)
        expect(outsider.locator('[data-personal-balance]')).to_have_attribute('data-personal-balance','0')
        expect(friend.locator('.member')).to_have_count(3)
        owner.locator('[data-action="edit-expense"]').click()
        owner.locator('[name="title"]').fill('충돌한 저장')
        friend.locator('[data-action="create-expense"]').first.click()
        friend.locator('[name="title"]').fill('친구가 산 커피');friend.locator('[name="amount"]').fill('4000')
        friend.get_by_role('button',name='저장하기',exact=True).click()
        expect(owner.locator('.expense-row')).to_have_count(2)
        owner.get_by_role('button',name='저장하기',exact=True).click()
        expect(owner.locator('#form-error')).to_contain_text('친구가 먼저 변경했어요')
        owner.get_by_role('button',name='취소',exact=True).click()
        # A brand-new browser restores the owner's trip through login alone.
        another=browser.new_context();setup_routes(another,'owner');device=another.new_page()
        device.goto(base);device.get_by_role('button',name='로그인',exact=True).click()
        device.get_by_role('button',name='구글로 계속하기',exact=True).click()
        device.get_by_role('link',name='로그인 공유 여행 열기',exact=True).click()
        expect(device.locator('[data-personal-balance]')).to_have_attribute('data-personal-balance','3666')
        device.get_by_role('button',name='🌿 지우',exact=True).click()
        device.get_by_role('button',name='로그아웃',exact=True).click()
        expect(device.locator('.personal-settlement')).to_have_count(0)
        expect(device.get_by_role('button',name='로그인',exact=True)).to_be_visible()
        for page in [owner,friend]:
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors,errors
        browser.close()
    print('PASS: simulated Google/Kakao PKCE redirects + actual PostgreSQL account RPC, common invite, profile, sync, distinct balances, same-name isolation, fresh-device restore, logout privacy, mobile')
finally:
    server.shutdown();server.server_close()

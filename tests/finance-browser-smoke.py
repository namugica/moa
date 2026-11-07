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
            function='moa_finance_api' if path.endswith('moa_finance_api') else 'moa_account_api' if path.endswith('moa_account_api') else 'moa_api'
            rpc_args="j->>'action',(j->>'trip_id')::uuid,coalesce(j->'payload','{}'::jsonb)" if function=='moa_finance_api' else "j->>'action',(j->>'trip_id')::uuid,j->>'session_token',j->>'invite_token',coalesce(j->'payload','{}'::jsonb)"
            sql=f"""begin;set local role {role};
            select set_config('request.jwt.claims','{claims}',true);
            with args as (select '{raw}'::jsonb j)
            select public.{function}({rpc_args}) from args;
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
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  contexts=[browser.new_context() for _ in range(2)]
  for context,identity in zip(contexts,['owner','friend']):setup_routes(context,identity)
  owner,friend=[c.new_page() for c in contexts]
  errors=[]
  for page in [owner,friend]:page.on('pageerror',lambda e:errors.append(str(e)))
  def login(page,name):
   page.get_by_role('button',name='구글로 계속하기',exact=True).click()
   page.locator('[name="profileName"]').fill(name)
   page.get_by_role('button',name='저장하기',exact=True).click()
   expect(page.locator('#editor')).not_to_be_visible()
  def save(page):
   page.locator('.finance-dialog').get_by_role('button',name='저장하기',exact=True).click()
   expect(page.locator('.finance-dialog')).to_have_count(0)
  owner.goto(base);owner.get_by_role('button',name='로그인',exact=True).click();login(owner,'지우')
  owner.locator('[data-action="create-trip"]').first.click()
  owner.locator('[name="title"]').fill('우리 모임')
  owner.get_by_role('button',name='저장하기',exact=True).click()
  owner.get_by_role('button',name='친구 초대',exact=True).click()
  owner.get_by_role('button',name='저장하기',exact=True).click()
  owner.locator('[name="inviteLink"]').wait_for();link=owner.locator('[name="inviteLink"]').input_value()
  owner.get_by_role('button',name='닫기',exact=True).click()
  friend.goto(link);login(friend,'민지');friend.get_by_role('button',name='초대 수락하고 참여하기',exact=True).click()
  for page in [owner,friend]:page.get_by_role('link',name='지출·공동 자금',exact=True).click()
  friend.locator('[data-finance="submit"]').click()
  for name,value in [('title','행사 준비물'),('amount','32500'),('purpose','준비물 구매'),('missing_reason','영수증 분실')]:friend.locator(f'.finance-dialog [name="{name}"]').fill(value)
  save(friend)
  expect(friend.locator('.finance-entry')).to_contain_text('검토 대기')
  owner.locator('[data-finance="refresh"]').click()
  owner.locator('[data-finance="review"]').click()
  owner.locator('.finance-dialog [name="status"]').select_option('changes')
  owner.locator('.finance-dialog [name="note"]').fill('사진을 첨부해 주세요');save(owner)
  friend.locator('[data-finance="refresh"]').click()
  expect(friend.locator('.finance-entry')).to_contain_text('사진을 첨부해 주세요')
  friend.locator('[data-finance="edit"]').click()
  # Real file input through the browser; tiny valid PNG fixture.
  import base64
  photo=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
  friend.locator('[name="photo"]').set_input_files({'name':'receipt.png','mimeType':'image/png','buffer':photo});save(friend)
  owner.locator('[data-finance="refresh"]').click()
  owner.locator('[data-finance="receipt"]').click()
  expect(owner.locator('.finance-receipt')).to_be_visible()
  owner.locator('.finance-dialog [data-dismiss]').click()
  owner.locator('[data-finance="review"]').click();save(owner)
  friend.locator('[data-finance="refresh"]').click()
  expect(friend.locator('.finance-summary')).to_contain_text('32,500원')
  expect(friend.locator('[data-finance="cash"]')).to_have_count(0)
  owner.locator('[data-finance="cash"]').click()
  owner.locator('.finance-dialog [name="title"]').fill('공동 자금 입금');owner.locator('.finance-dialog [name="amount"]').fill('100000');save(owner)
  owner.locator('[data-finance="pay"]').click();save(owner)
  expect(owner.locator('.finance-summary')).to_contain_text('67,500원')
  friend.reload();expect(friend.locator('.finance-entry')).to_contain_text('지급 완료')
  expect(friend.locator('.finance-summary')).to_contain_text('0원')
  for page in [owner,friend]:
   page.set_viewport_size({'width':390,'height':844})
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  owner.screenshot(path='/tmp/moa-finance-manager.png',full_page=True)
  friend.screenshot(path='/tmp/moa-finance-member.png',full_page=True)
  assert not errors,errors
  browser.close()
 print('PASS: finance browser submission, correction, photo, approval, cash, payout, personal balance, reload, mobile')
finally:
 server.shutdown();server.server_close()

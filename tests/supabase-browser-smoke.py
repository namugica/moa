"""Optional: exercise the real SQL RPC from isolated browsers using a disposable DB.
Requires Python Playwright, Chromium, and the local Docker database from README.
No requests or test records are sent to the configured live Supabase project.
"""
import json
import os
from pathlib import Path
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
CONTAINER = os.environ.get('MOA_TEST_CONTAINER', 'moa-supabase-check')

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)
    def log_message(self, *args):
        pass

def rpc(route):
    request = route.request
    if request.method == 'OPTIONS':
        route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey,content-type'})
        return
    assert request.headers.get('apikey', '').startswith('sb_publishable_')
    assert 'authorization' not in request.headers
    raw = json.dumps(request.post_data_json, ensure_ascii=False).replace("'", "''")
    sql = f"""set role anon;
    with args as (select '{raw}'::jsonb j)
    select public.moa_api(j->>'action', (j->>'trip_id')::uuid,
      j->>'session_token', j->>'invite_token', coalesce(j->'payload','{{}}'::jsonb)) from args;"""
    result = subprocess.run(['docker', 'exec', CONTAINER, 'psql', '-U', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], check=True, capture_output=True, text=True)
    body = json.loads(result.stdout)
    route.fulfill(status=200, headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, body=json.dumps(body))

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        contexts = [browser.new_context() for _ in range(3)]
        for context in contexts:
            context.route('https://*.supabase.co/rest/v1/rpc/moa_api', rpc)
        owner, friend, outsider = [context.new_page() for context in contexts]
        errors = []
        for page in [owner, friend, outsider]:
            page.on('pageerror', lambda error: errors.append(str(error)))
        owner.goto(base)
        owner.locator('[data-action="create-trip"]').first.click()
        for name, value in [('myName','지우'),('title','Supabase 공유 여행'),('destination','제주'),('start','2026-11-01'),('end','2026-11-02'),('names','민지')]:
            owner.locator(f'[name="{name}"]').fill(value)
        owner.get_by_role('button', name='저장하기', exact=True).click()
        owner.get_by_role('button', name='친구 초대', exact=True).click()
        owner.get_by_role('button', name='저장하기', exact=True).click()
        owner.locator('[name="inviteLink"]').wait_for()
        link = owner.locator('[name="inviteLink"]').input_value()
        owner.get_by_role('button', name='닫기', exact=True).click()
        friend.goto(link)
        friend.get_by_role('button', name='초대 수락하고 참여하기', exact=True).click()
        expect(friend.locator('.personal-settlement .eyebrow')).to_have_text('민지님의 정산')
        expect(friend.locator('#sync-status')).to_have_text('자동 동기화 · 2초마다')
        owner.locator('[data-action="create-expense"]').first.click()
        owner.locator('[name="title"]').fill('함께 먹은 점심')
        owner.locator('[name="amount"]').fill('10001')
        owner.get_by_role('button', name='저장하기', exact=True).click()
        expect(owner.locator('[data-personal-balance]')).to_have_attribute('data-personal-balance', '5000')
        expect(friend.locator('[data-personal-balance]')).to_have_attribute('data-personal-balance', '-5000')
        expect(friend.locator('.expense-row')).to_contain_text('함께 먹은 점심')
        owner.locator('[data-action="edit-expense"]').click()
        owner.locator('[name="title"]').fill('충돌한 변경')
        friend.locator('[data-action="create-expense"]').first.click()
        expect(friend.locator('[name="payerId"] option:checked')).to_have_text('민지')
        friend.locator('[name="title"]').fill('친구가 산 커피')
        friend.locator('[name="amount"]').fill('4000')
        friend.get_by_role('button', name='저장하기', exact=True).click()
        expect(owner.locator('.expense-row')).to_have_count(2)
        owner.get_by_role('button', name='저장하기', exact=True).click()
        expect(owner.locator('#form-error')).to_contain_text('친구가 먼저 변경했어요')
        owner.get_by_role('button', name='취소', exact=True).click()
        friend.reload()
        expect(friend.locator('[data-personal-balance]')).to_have_attribute('data-personal-balance', '-3000')
        outsider.goto(link)
        expect(outsider.locator('main [role="alert"]')).to_contain_text('이미 사용했거나 만료된')
        for page in [owner, friend]:
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        browser.close()
    print('PASS: Supabase adapter + real PostgreSQL RPC, owner/friend invitation, 2-second sync, personal balances, conflict, persistence, single-use link, mobile layout')
finally:
    server.shutdown()
    server.server_close()

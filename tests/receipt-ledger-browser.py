"""Receipt-first ledger on the actual Node server/CSP and real Tesseract OCR.
Requires Python Playwright, Pillow, Chromium and a Noto CJK font. Uses verified
HTTPS through the host CA store for CDN assets. Supabase calls are intercepted;
this test never reads or modifies the production project.
Run: python3 tests/receipt-ledger-browser.py
"""
import json
import urllib.request
import os
import socket
import subprocess
import tempfile
import atexit
import time
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
(ROOT/'work').mkdir(exist_ok=True)
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
data_dir=tempfile.TemporaryDirectory(prefix='moa-ledger-browser-')
server=subprocess.Popen(['node','server.mjs'],cwd=ROOT,env={**os.environ,'HOST':'127.0.0.1','PORT':str(port),'MOA_DATA_DIR':data_dir.name},stdout=subprocess.DEVNULL)
def cleanup():
 server.terminate();server.wait(timeout=10);data_dir.cleanup()
atexit.register(cleanup)
BASE=f'http://127.0.0.1:{port}'
for attempt in range(100):
 try:
  with urllib.request.urlopen(BASE,timeout=1):break
 except OSError:time.sleep(.05)
else:raise RuntimeError('Local Node server did not start')
img=Image.new('RGB',(1000,1000),'white');d=ImageDraw.Draw(img);font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',48)
for i,line in enumerate(['영수증','2026-11-18','합계 48,000원','카드번호 1234']):d.text((80,100+i*150),line,font=font,fill='black')
img.save(ROOT/'work/receipt.png')
trip={'id':'receipt-test','title':'우리 제주 여행','destination':'제주','start':'2026-11-18','end':'2026-11-18','status':'planning','members':[{'id':'a','name':'나'},{'id':'b','name':'민지'},{'id':'c','name':'수현'}],'items':[],'expenses':[],'fundEntries':[{'id':'f'+m,'memberId':m,'kind':'contribution','amount':100000,'date':'2026-11-18'} for m in ['a','b','c']]}
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 context=browser.new_context(viewport={'width':1280,'height':1000})
 def trusted_fetch(route):
  # Verify HTTPS with the execution environment's CA store, including worker assets.
  with urllib.request.urlopen(route.request.url,timeout=90) as r:
   route.fulfill(status=r.status,body=r.read(),headers={'Content-Type':r.headers.get('Content-Type','application/octet-stream'),'Access-Control-Allow-Origin':'*'})
 context.route('https://cdn.jsdelivr.net/**',trusted_fetch)
 context.route('https://tessdata.projectnaptha.com/**',trusted_fetch)
 context.route('https://*.supabase.co/**',lambda route:route.fulfill(status=200,headers={'Access-Control-Allow-Origin':'*'},json={'external':{}}))
 page=context.new_page();errors=[];logs=[]
 page.on('pageerror',lambda e:errors.append(str(e)));page.on('console',lambda m:logs.append(m.text) if m.type=='error' else None)
 page.goto(BASE);page.evaluate('(trip)=>localStorage.setItem("moa.prototype.v1",JSON.stringify({trips:[trip]}))',trip)
 page.goto(BASE+'/#trip/receipt-test');page.reload()
 expect(page.locator('.ledger-summary')).to_contain_text('300,000원')
 page.locator('[data-action="create-expense"]').click()
 page.locator('[name="amount"]').fill('240000');page.get_by_role('button',name='기록하기',exact=True).click()
 expect(page.locator('.ledger-summary')).to_contain_text('60,000원')
 # Real OCR: bundled browser module + CDN worker and Korean model, on the Node CSP.
 page.locator('[data-action="create-expense"]').click()
 page.locator('#f-receipt-gallery').set_input_files(str(ROOT/'work/receipt.png'))
 try:
  expect(page.locator('[data-expense-ocr]')).to_contain_text('금액',timeout=180000)
  expect(page.locator('[name="amount"]')).to_have_value('48000')
  print('REAL_OCR_PASS',flush=True)
 except Exception:
  print('REAL_OCR_FAILED',page.locator('[data-expense-ocr]').inner_text(),logs,flush=True)
  raise
 page.locator('[name="payment"][value="personal"]').check()
 page.set_viewport_size({'width':390,'height':844})
 page.screenshot(path=str(ROOT/'work/receipt-confirm-mobile.png'),full_page=True)
 save_box=page.get_by_role('button',name='기록하기',exact=True).bounding_box()
 assert save_box['y']+save_box['height']<844,'Save must stay visible without scrolling'
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 page.set_viewport_size({'width':1280,'height':1000})
 # Merchant not required; leave it empty.
 page.locator('details').evaluate('(el)=>el.open=true');page.locator('[name="title"]').fill('')
 page.get_by_role('button',name='기록하기',exact=True).click()
 expect(page.locator('.ledger-amount')).to_have_count(5)
 expect(page.locator('.ledger-summary')).to_contain_text('288,000원')
 page.get_by_role('link',name='정산',exact=True).click()
 expect(page.locator('.transfer-list')).to_contain_text('52,000원')
 expect(page.locator('.transfer-list')).to_contain_text('4,000원')
 page.get_by_role('button',name='돌려줬어요',exact=True).first.click()
 expect(page.locator('.board-total')).to_contain_text('8,000원')
 page.reload();expect(page.locator('.board-total')).to_contain_text('8,000원')
 page.screenshot(path=str(ROOT/'work/settlement-desktop.png'),full_page=True)
 page.get_by_role('link',name='내역',exact=True).click()
 page.screenshot(path=str(ROOT/'work/ledger-desktop.png'),full_page=True)
 for width in [390,320]:
  page.set_viewport_size({'width':width,'height':844})
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),f'overflow {width}'
  if width==390:page.screenshot(path=str(ROOT/'work/ledger-mobile.png'),full_page=True)
 page.locator('[data-action="create-expense"]').click();page.locator('[name="amount"]').fill('1')
 for c in page.locator('[name="participants"]').all():c.uncheck()
 page.get_by_role('button',name='기록하기',exact=True).click();expect(page.locator('#form-error')).not_to_be_empty()
 page.get_by_role('button',name='닫기',exact=True).click()
 assert not errors,errors
 print('UI_PASS: amount-only save, pooled and personal payment, exact settlement, completion persistence, mobile 390/320, empty participant guard',flush=True)
 # A new expense after a real fund payout must preserve that payout.
 page.locator('[data-action="create-expense"]').click();page.locator('[name="amount"]').fill('3000')
 page.locator('[name="payment"][value="fund"]').check()
 page.get_by_role('button',name='기록하기',exact=True).click()
 expect(page.locator('.ledger-summary')).to_contain_text('5,000원')
 expect(page.locator('.my-balance-link')).to_contain_text('1,000원 보내요')
 # Creation, contribution, refund, and deletion use the same ledger.
 page.goto(BASE);page.locator('[data-action="create-trip"]').first.click()
 page.locator('[name="title"]').fill('새 장부');page.locator('[name="initialFund"]').fill('5000')
 page.get_by_role('button',name='저장하기',exact=True).click()
 expect(page.locator('.ledger-summary')).to_contain_text('5,000원')
 page.locator('[data-action="fund-entry"]').click();page.locator('[name="amount"]').fill('1000')
 page.get_by_role('button',name='저장하기',exact=True).click();expect(page.locator('.ledger-summary')).to_contain_text('6,000원')
 page.locator('[data-action="refund-entry"]').click();page.locator('[name="amount"]').fill('500')
 page.get_by_role('button',name='저장하기',exact=True).click();expect(page.locator('.ledger-summary')).to_contain_text('5,500원')
 page.locator('.ledger-row').filter(has_text='돌려준 돈').get_by_role('button',name='삭제',exact=True).click()
 page.get_by_role('button',name='저장하기',exact=True).click();expect(page.locator('.ledger-summary')).to_contain_text('6,000원')
 print('UI_PASS: payout carry-forward, new Space, contributions, refund deletion',flush=True)
 print('CONSOLE',logs,flush=True)
 browser.close()

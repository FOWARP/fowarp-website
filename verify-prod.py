import asyncio
from playwright.async_api import async_playwright
URL="https://fowarp.vercel.app/nosugaradded?cb=verify1"
OUT="/private/tmp/claude-501/-Users-nuri/5d2ea6a1-9471-438d-b0bc-3a7e55ecc35f/scratchpad/shots"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch()
        pg=await b.new_page(viewport={"width":1920,"height":1080})
        failed=[]
        pg.on("response", lambda r: failed.append((r.status, r.url.split('/')[-1])) if r.status>=400 else None)
        await pg.goto(URL, wait_until="load")
        await pg.wait_for_timeout(2500)
        h=await pg.evaluate("document.documentElement.scrollHeight")
        y=0
        while y<h:
            y+=700; await pg.evaluate(f"window.scrollTo(0,{y})"); await pg.wait_for_timeout(150)
        await pg.wait_for_timeout(3000)
        res=await pg.evaluate("""(()=>{const d=document.querySelector('.dark-section');const r=d.getBoundingClientRect();
          return {docH:document.documentElement.scrollHeight, blocks:document.querySelectorAll('.media-block').length,
          visible:document.querySelectorAll('.project-media > .reveal.is-visible').length,
          lenisLimit: lenis.limit, maxScroll: document.documentElement.scrollHeight-window.innerHeight,
          darkFullBleed: r.left===0 && Math.round(r.width)===window.innerWidth,
          darkEndsAtDocEnd: Math.round(r.bottom+window.scrollY)===document.documentElement.scrollHeight,
          horiz: document.documentElement.scrollWidth>window.innerWidth,
          notLoaded: Array.from(document.images).filter(i=>!i.complete||i.naturalWidth===0).length};})()""")
        print("PROD", res)
        print("FAILED", failed[:8])
        await pg.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
        await pg.wait_for_timeout(1200)
        await pg.screenshot(path=f"{OUT}/prod-bottom.png")
        await b.close()
asyncio.run(main())

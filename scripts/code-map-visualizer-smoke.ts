/** Tests shipped view assets with the public SDK protocol under an offline, opaque iframe. */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, expect } from '@playwright/test';

async function main(): Promise<void> {
  const shell = `
window.opens=[];window.requests=[];let project='p',generation=1;window.ports=[];
const file={id:'f:api.ts',kind:'file',label:'api.ts',path:'api.ts',sha256:'0'.repeat(64),whyIncluded:'indexed file'};
const symbol={id:'s:api',kind:'symbol',label:'api',path:'api.ts',sha256:'0'.repeat(64),span:[2,7,2,30],whyIncluded:'contains'};
window.addEventListener('message',e=>{if(e.data?.type!=='oxy:hello')return;const c=new MessageChannel();window.ports.push(c.port1);
c.port1.onmessage=async({data:m})=>{if(m.t!=='req'&&m.t!=='shell')return;window.requests.push(m);let result=null;
if(m.method==='model')result={project:{id:project,name:window.previewSlice?'Oxytocin':project==='p'?'Fixture':'Other project'},checkouts:[{projectId:project,checkoutId:project,label:'Main checkout',mode:'project'}]};
if(m.method==='query'){const s=m.payload;const nodes=s.view==='overview'?[file]:[file,symbol];result={projectId:project,response:{checkoutId:project,code:'OK',truncated:false,reasons:[],hint:'Missing edges do not prove code is unused.',freshness:{generation,state:'ready',stale:false,coverage:{files:{indexed:2,unsupported:0,skipped:0,failed:0},unresolved:{imports:0,calls:0}},warnings:[]},data:window.previewSlice??(s.view==='search'?{kind:'search',matches:[{id:'s:api',path:'api.ts',name:'api',kind:'function',stale:false,score:1,whyIncluded:['exact'] }]}:{kind:'slice',view:s.view,nodes,edges:s.view==='overview'?[]:[{from:file.id,to:symbol.id,rel:'contains',prov:'syntax',whyIncluded:'membership'}],visitedNodes:2,visitedEdges:1,exhaustive:false})}};}
if(m.method==='open')window.opens.push(m.payload);
c.port1.postMessage({t:'res',id:m.id,ok:true,result});};
e.source.postMessage({type:'oxy:init',protocol:1,viewId:'map',kind:'panel',locale:'en',theme:{'--accent':'#4f8cff','--text-primary':'#e6e8eb','--text-muted':'#9fa9b8','--bg-card':'#151a20','--border-default':'#2c333d'},reservedKeybindings:[],visible:true},'*',[c.port2]);});
window.switchProject=()=>{project='other';window.ports.forEach(p=>p.postMessage({t:'msg',payload:{type:'reset',projectId:project}}));};
window.visibility=(visible)=>window.ports.forEach(p=>p.postMessage({t:'evt',name:'visibility',payload:visible}));
window.invalidate=()=>{generation++;window.ports.forEach(p=>p.postMessage({t:'msg',payload:{type:'invalidate',projectId:project}}));};`;
  const root = resolve('plugins/code-map-visualizer/dist/views');
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '/';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self' http://127.0.0.1:*; style-src 'self' http://127.0.0.1:* 'unsafe-inline'; frame-src 'self'; img-src data:; connect-src 'none'",
    );
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<script src="/shell.js"></script><iframe sandbox="allow-scripts" src="/view/map.html" style="width:1200px;height:900px"></iframe>',
      );
    } else if (path === '/shell.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(shell);
    } else if (path.startsWith('/view/') && !path.includes('..')) {
      const file = resolve(root, path.slice(6));
      if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      res.setHeader(
        'Content-Type',
        extname(file) === '.js' ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'text/html',
      );
      void readFile(file).then(
        (content) => res.end(content),
        () => res.writeHead(404).end(),
      );
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } }),
      errors: string[] = [],
      remote: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1:')) remote.push(r.url());
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('heading', { name: 'Code Map · Fixture' })).toBeVisible();
    await expect(frame.getByRole('table', { name: 'Code Map nodes' })).toHaveCount(0);
    await expect(frame.getByLabel('Code dependency graph')).toBeVisible();
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/code-map-visualizer-overview.png' });
    await frame.getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'api.ts', exact: true })).toBeVisible();
    await frame.getByRole('textbox', { name: 'Search code' }).fill('api');
    await frame.getByRole('button', { name: 'Find', exact: true }).click();
    const symbolButton = frame.getByRole('button', { name: 'api', exact: true });
    await expect(symbolButton)
      .toBeVisible()
      .catch(async (error) => {
        console.log(await page.evaluate('window.requests'));
        console.log(await frame.locator('body').innerText());
        console.log(errors);
        throw error;
      });
    await symbolButton.focus();
    await page.keyboard.press('Enter');
    await frame.getByRole('button', { name: 'Explore one step' }).click();
    await expect(frame.getByRole('button', { name: 'api.ts', exact: true })).toBeVisible();
    await symbolButton.click();
    await frame.getByRole('button', { name: 'Open in editor' }).click();
    await expect.poll(() => page.evaluate('window.opens.length')).toBe(1);
    const opened: unknown = await page.evaluate('window.opens[0]');
    expect(opened).toMatchObject({ checkoutId: 'p', path: 'api.ts', symbolId: 's:api', span: [2, 7, 2, 30] });
    await page.evaluate('window.invalidate()');
    await expect(frame.locator('header')).toContainText('Generation 2');
    await page.evaluate('window.visibility(false)');
    await expect.poll(() => page.evaluate('window.requests.filter(r=>r.method==="cancel").length')).toBeGreaterThan(0);
    await page.evaluate('window.visibility(true)');
    await page.evaluate('window.switchProject()');
    await expect(frame.getByRole('heading', { name: 'Code Map · Other project' })).toBeVisible();
    const preview = await readFile('test-results/code-map-preview-slice.json', 'utf8').catch(() => undefined);
    if (preview) {
      await page.evaluate((slice) => {
        Object.assign(window, { previewSlice: JSON.parse(slice) as unknown });
      }, preview);
      await frame.getByRole('textbox', { name: 'Search code' }).fill('');
      await frame.getByRole('button', { name: 'Code', exact: true }).click();
      await expect(frame.locator('.counts')).not.toContainText('1 nodes');
      const canvas = frame.getByLabel('Code dependency graph');
      const bounds = await canvas.boundingBox();
      expect(bounds!.height).toBeGreaterThan(500);
      await page.screenshot({ path: 'test-results/code-map-visualizer-services.png' });
      // Select from the accessible outline, then return to the same graph and inspect its neighborhood.
      await frame.getByRole('button', { name: 'Outline', exact: true }).click();
      await frame.getByRole('table').getByRole('button', { name: 'code-map', exact: true }).click();
      await frame.getByRole('button', { name: 'Outline', exact: true }).click();
      await expect(frame.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
      await page.locator('iframe').screenshot({ path: 'test-results/code-map-visualizer-selected.png' });
      await page.locator('iframe').evaluate((element) => {
        element.style.width = '600px';
        element.style.height = '600px';
      });
      await expect(canvas).toBeVisible();
      await page.screenshot({ path: 'test-results/code-map-visualizer-narrow.png' });
    }
    expect(errors).toEqual([]);
    expect(remote).toEqual([]);
    await writeFile(
      'test-results/code-map-visualizer-smoke.json',
      JSON.stringify(
        {
          chromium: browser.version(),
          errors,
          remote,
          opened,
          checks: [
            'shipped opaque iframe',
            'CSP offline',
            'keyboard list',
            'search',
            'neighborhood',
            'source locator',
            'invalidation',
            'visibility cancellation',
            'project switch',
          ],
        },
        null,
        2,
      ) + '\n',
    );
    console.log('Visualizer shipped-asset iframe smoke passed');
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

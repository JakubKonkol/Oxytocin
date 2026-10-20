/** Headless Chromium renderer spike; does not start Electron or invoke agents. */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

async function main(): Promise<void> {
  const library = await readFile('node_modules/cytoscape/dist/cytoscape.min.js');
  const fixture = `
const cy = cytoscape({ container: document.getElementById('graph'), elements: [],
  style: [{selector:'node',style:{label:'data(label)','font-size':10,'text-max-width':110,'text-wrap':'ellipsis'}},
    {selector:'edge',style:{width:1,'target-arrow-shape':'triangle','curve-style':'bezier'}}],
  layout:{name:'preset'}, pixelRatio:1, textureOnViewport:true, hideEdgesOnViewport:true });
let layoutMs=0, start=performance.now();
const size=Number(new URL(location.href).searchParams.get('n'));
cy.batch(()=>{ for(let i=0;i<size;i++) cy.add({data:{id:'n'+i,label:'Long module path and symbol '+i},position:{x:(i%23)*140,y:Math.floor(i/23)*90}});
  for(let i=0;i<Math.min(size*2,1000);i++) cy.add({data:{id:'e'+i,source:'n'+(i%size),target:'n'+(i%3===0?0:(i*7+1)%size)}}); });
cy.fit();
requestAnimationFrame(()=>requestAnimationFrame(()=>{ layoutMs=performance.now()-start; window.ready=true; }));
window.measure=async()=>{const samples=[], frames=[]; let previous=performance.now();
for(let i=0;i<120;i++) await new Promise(resolve=>requestAnimationFrame(now=>{frames.push(now-previous);previous=now;resolve();}));
for(let i=0;i<30;i++){const t=performance.now();cy.panBy({x:i%2?2:-2,y:0});await new Promise(resolve=>requestAnimationFrame(resolve));samples.push(performance.now()-t);}
// Replacement bursts keep surviving positions rather than rerunning a force layout.
const refresh=performance.now();for(let i=0;i<20;i++){cy.batch(()=>cy.nodes().forEach(n=>n.data('label',n.id()+' revision '+i)));}
samples.sort((a,b)=>a-b);return {nodes:size,edges:cy.edges().length,firstUsableMs:layoutMs,inputP95Ms:samples[Math.ceil(samples.length*.95)-1],fps:1000/(frames.reduce((a,b)=>a+b,0)/frames.length),refreshBurstMs:performance.now()-refresh,heapBytes:performance.memory?.usedJSHeapSize??null,renderer:'canvas',layout:'preset grid'};};
`;
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self' http://127.0.0.1:*; style-src 'unsafe-inline'; frame-src 'self'",
    );
    if (path === '/cy.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(library);
    } else if (path === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fixture);
    } else if (path === '/frame') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<div id="graph" style="width:1100px;height:700px"></div><script src="/cy.js"></script><script src="/fixture.js"></script>',
      );
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<iframe sandbox="allow-scripts" src="/frame?${req.url?.split('?')[1] ?? ''}" style="width:1150px;height:750px"></iframe>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No benchmark address');
  const browser = await chromium
    .launch({ headless: true, args: ['--enable-precise-memory-info'] })
    .catch(async (error) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    });
  try {
    const results: unknown[] = [];
    for (const n of [50, 150, 500]) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/?n=${n}`);
      const frame = page.frames()[1]!;
      await frame.waitForFunction('window.ready === true');
      results.push({ ...(await frame.evaluate<Record<string, unknown>>('window.measure()')), errors });
      await page.close();
    }
    const pkg = JSON.parse(await readFile('node_modules/cytoscape/package.json', 'utf8')) as {
      version: string;
      license: string;
    };
    const result = {
      time: new Date().toISOString(),
      platform: process.platform,
      node: process.version,
      chromium: browser.version(),
      cytoscape: pkg.version,
      license: pkg.license,
      results,
      terminalRegression: null,
      packagedElectron: null,
    };
    await writeFile('test-results/code-map-renderer.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ chromium: result.chromium, results }, null, 2));
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

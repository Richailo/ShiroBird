const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'bridge.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'bridge.css'),'utf8');
const begin=script.indexOf('  function updateNavigation() {');
const end=script.indexOf('  function netbirdToken() {',begin);
assert.ok(begin>0&&end>begin,'selection function exists');
class Node {
  constructor(slug='') {
    this.dataset={shirobirdPage:slug};this.attrs={};this.classes=new Set();
    this.classList={toggle:(key,on)=>on?this.classes.add(key):this.classes.delete(key),contains:key=>this.classes.has(key)};
  }
  setAttribute(k,v){this.attrs[k]=v;}
  removeAttribute(k){delete this.attrs[k];}
}
const html=new Node(), parent=new Node();
const links=['traffic-flow','siem-integration','customize'].map(x=>new Node(x));
const submenu={hidden:true,querySelectorAll:()=>links};
const nav=new Node();
nav.querySelector=q=>q==='#shirobird-menu-toggle'?parent:submenu;
const document={documentElement:html,getElementById:id=>id==='shirobird-nav-link'?nav:null};
let selected={slug:'traffic-flow'};
let expanded=true,mode=0,visibility=0;
const update=Function('document','NAV_ID','selectedPage','syncSidebarMode','applyVisibility','expanded',
  script.slice(begin,end)+'\nreturn updateNavigation;')(
  document,'shirobird-nav-link',()=>selected,()=>mode++,()=>visibility++,expanded);
for(const slug of ['traffic-flow','siem-integration','customize']){
  selected={slug};update();
  assert.equal(html.classList.contains('shirobird-route-active'),true);
  assert.equal(links.filter(b=>b.classList.contains('shirobird-selected')).length,1);
  assert.equal(links.find(b=>b.classList.contains('shirobird-selected')).dataset.shirobirdPage,slug);
  assert.equal(parent.attrs['aria-current'],'true');
}
selected=null;update();
assert.equal(html.classList.contains('shirobird-route-active'),false);
assert.equal(links.filter(b=>b.classList.contains('shirobird-selected')).length,0);
assert.equal(parent.attrs['aria-current'],'false');
assert.equal(mode,4);assert.equal(visibility,4);
assert.match(css,/html\.shirobird-route-active \[data-navigation\] button\[data-testid="left-navigation-item"\]\.bg-gray-200/);
assert.match(css,/html\.dark\.shirobird-route-active \[data-navigation\]/);
assert.match(css,/background-color: transparent !important/);
// NetBird's active SVG fill is controlled separately from the selected row.
// Require a peer/icon data-active override ONLY under the ShiroBird hash route.
const nativeIconSelector='.peer'+String.fromCharCode(92)+'/icon[data-active="true"] ~ [class*="peer-data-"]';
assert.equal(css.split(nativeIconSelector).length-1,2,'light and dark icon overrides exist');
assert.match(css,/fill: #6b7280 !important/,'light icon matches inactive NetBird');
assert.match(css,/fill: #7c8994 !important/,'dark icon matches inactive NetBird');
assert.match(script,/history\.replaceState\(history\.state, "", location\.pathname \+ location\.search\)/);
console.log('PASS: one active ShiroBird child; NetBird background and light\/dark icon selection reset on exit.');

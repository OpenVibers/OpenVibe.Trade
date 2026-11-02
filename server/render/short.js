'use strict';
/**
 * The home on a phone (the owner's rule, 2026-10-31: never hide content to shorten): every block is shown, stacked,
 * each with its own heading. The chips are links that jump to a block.
 *
 *   pickBlock()  several blocks of the same kind, all shown; the chips are a row of links to them, never a picker.
 *   foldBlock()  a part a reader rarely needs, closed on a phone and open where there is room. The page's own markup
 *                keeps it open, so a browser without the script shows it as before; the script closes it on a narrow
 *                screen and remembers the reader's choice.
 *
 * The CSS for both lives in public/css/trade.css.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A pick block. The panes are the page's own blocks, all shown, each with its own heading; the chips are links that
 * jump to them.
 *
 *   pickBlock({ key, label, head, panes })   panes: [{ id, label, html }]
 */
function pickBlock({ key, label, head = '', panes }) {
    if (!panes.length) return '';
    const chips = panes.map((p) => `<a class="pick-chip" href="#${esc(p.id)}">${esc(p.label)}</a>`).join('');
    // The pane carries the id the page already links to (an anchor in the hero, for instance), so the chip and any
    // link to it land on that block.
    const body = panes.map((p) => `<div class="pick-pane" id="${esc(p.id)}">${p.html}</div>`).join('');
    return `<div class="pick" id="pick-${esc(key)}"><div class="pick-bar"><div class="pick-head"><h2>${esc(head || label)}</h2></div><nav class="pick-row" aria-label="${esc(label)}">${chips}</nav></div><div class="pick-body">${body}</div></div>`;
}

/**
 * A fold. The head is the heading the block had; the html is what it holds.
 *
 *   foldBlock({ id, head, html })
 */
function foldBlock({ id, head, html }) {
    return `<details class="tr-fold tr-fold-block" id="${esc(id)}" open><summary>${head}<span>tap to open</span></summary>${html}</details>${foldScript(id)}`;
}

/** The script a fold carries: closed on a phone unless the reader opened it before, and it remembers that. */
function foldScript(id) {
    return `<script>(function(){var d=document.getElementById(${JSON.stringify(id)});if(!d)return;var k='ov_fold_'+${JSON.stringify(id)};var s=null;try{s=localStorage.getItem(k)}catch(e){}if(s==='open'){d.open=true;return}if(s==='closed'){d.open=false;return}var t=0;if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){t=Date.now();d.open=false}d.addEventListener('toggle',function(){if(Date.now()-t<300)return;try{localStorage.setItem(k,d.open?'open':'closed')}catch(e){}})})();</script>`;
}

module.exports = { pickBlock, foldBlock, foldScript };

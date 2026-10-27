// Only recognized explanatory prose is removed; findings and receipt paging stay byte-for-byte intact.
const GREP_LEGEND = '<!-- ripwire grep schema=ripwire.grep/v1: literal/regex scan grouped by file: <f p=><hit l= in=>CDATA text</hit> (<b>/<a> context around it); complete=1 only for an exhaustive literal scan; <unindexed> = off-index. window: shown= total= capped= has_more= next_offset= offset= limit= (capped=1 cut; next_offset= pastes as offset=). hits_capped=1: hits= is a floor. root=: p= relative to it. next=: the one pasteable follow-up. pattern=: the search string as given. files=N: in-index files holding hits (the whole collected set, same on every page). suppressed_string=N: string-tier hits held back, not in hits=; the grep-in=any flag serves them. tier_parsed=N: hit files parsed to classify hits as code/comment/string (budgeted; see tier_budget=). tier_unclassified=N: hits in files never classified; nonzero = tier label unproven for them. unindexed_files_scanned=N: off-index text files also scanned; outside complete=. unindexed_hits=N: hits in off-index files, NOT in hits=/total=; listed in the trailing unindexed element. callers=N: 1-hop distinct callers of this name, all same-named defs (a FLOOR). cx=N: cyclomatic complexity, max over same-named defs; absent when 0.';
const DEFS = ' enc defs=N: the enclosing name has N defs, the row unions them (only above 1).';
const END = ' corpus_pruned_dirs=N: DIRECTORIES the built-in crawl denylist pruned whole (vendor, build etc), unsearched. -->';
const OPTIONAL = [DEFS, ' line_bytes=N: whole line N bytes; text is a cut prefix.', ' unindexed count=N: off-index hits, equal to unindexed_hits=; paged by the same window as the f rows.'];

function knownLegend(output: string): string | undefined {
  const end = output.indexOf('-->');
  if (end < 0 || !output.slice(end + 3).startsWith('<grep ')) return;
  const prefix = output.slice(0, end + 3);
  const normalized = OPTIONAL.reduce((text, sentence) => text.replace(sentence, ''), prefix);
  return normalized === GREP_LEGEND + END ? prefix : undefined;
}
const LEGEND = 'grep/v1: p relative to root; hit l/in=line/enclosing symbol, b/a=context. complete=1 exhaustive literal only; capped=1 partial, hits_capped=1 floor; next is follow-up, next_offset is offset. files=all in-index hit files; suppressed_string excluded (grep-in=any retrieves); tier_unclassified unproven. unindexed outside complete/hits/total; corpus_pruned_dirs unsearched. callers=1-hop floor across same-name defs; cx=max complexity (absent=0); defs>1 unions definitions; line_bytes=whole bytes of cut line; unindexed count=unindexed_hits, same paging window.';

type NavigationReceipt = { id: string; action: string; status: string; exitCode: number | null; output: string; offset: number };

/** Provider text only: details and the archived original retain the complete CLI/MCP result. */
export function navigationPreview<T extends NavigationReceipt>(receipt: T): T & { legend?: string; recovery?: string } {
  if (receipt.action !== 'search' || receipt.status !== 'completed' || receipt.exitCode !== 0 || receipt.offset !== 0) return receipt;
  const prefix = knownLegend(receipt.output);
  if (!prefix) return receipt;
  return { ...receipt, output: receipt.output.slice(prefix.length), legend: LEGEND,
    recovery: `Full legend + raw output: project_evidence id=${receipt.id}. Offsets/totalBytes refer to the raw original.` };
}

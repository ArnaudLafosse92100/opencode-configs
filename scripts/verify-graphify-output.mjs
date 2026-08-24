#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
const graphPath = resolve(process.argv[2] ?? 'graphify-out/graph.json');
const outDir = dirname(graphPath);
const repoRoot = resolve(process.argv[3] ?? resolve(outDir, '..'));
const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(outDir, 'manifest.json'), 'utf8'));
const statIndex = JSON.parse(readFileSync(resolve(outDir, 'cache/stat-index.json'), 'utf8'));
const nodes = graph.nodes ?? []; const links = graph.links ?? graph.edges;
if (!graph.directed) throw new Error('Expected graph.directed to be true.');
if (!nodes.length || !Array.isArray(links)) throw new Error('Expected a non-empty graph.');
if (existsSync(resolve(outDir, 'memory'))) throw new Error('In-tree Graphify memory is prohibited.');
const prohibited = ['graphify-out/', '.graphify/', '.agents/', '.codex/', '.omo/', '.sisyphus/',
  'node_modules/', '.venv/', 'dist/', 'build/', '.cache/', 'agents/', 'prompts/', 'profiles/', 'skills/'];
const roots = ['scripts/', 'tests/'];
const exts = new Set(['.py', '.js', '.mjs', '.sh', '.bash']);
const norm = (v) => v.split(sep).join('/').replace(/^\.\//, '');
const forbidden = (v) => v.startsWith('../') || prohibited.some((p) => v.startsWith(p));
const eligible = (v) => !forbidden(v) && (exts.has(extname(v).toLowerCase()) || v === 'oc');
const digest = (v) => createHash('sha256').update(readFileSync(resolve(repoRoot, v)))
  .update(Buffer.from([0])).update(v.toLowerCase()).digest('hex');
const sources = new Set(nodes.map((n) => n.source_file).filter(Boolean));
const metadata = [...new Set([...sources, ...links.map((e) => e.source_file).filter(Boolean)])].map(norm);
const ids = new Set(nodes.map((n) => n.id));
const dangling = links.filter((e) => !ids.has(e.source) || !ids.has(e.target));
const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean).map(norm)
  .filter((p) => existsSync(resolve(repoRoot, p)));
const files = listed.filter(eligible);
const added = files.filter((p) => !Object.hasOwn(statIndex, p));
const changed = files.filter((p) => statIndex[p]?.hashes?.[p] && digest(p) !== statIndex[p].hashes[p]);
const deleted = Object.keys(manifest).filter((p) => eligible(p) && !existsSync(resolve(repoRoot, p)));
const missingRoots = roots.filter((root) => ![...sources].some((p) => p.startsWith(root)));
const bad = metadata.filter(forbidden);
if (bad.length) throw new Error(`Prohibited source paths: ${bad.slice(0, 5)}`);
if (missingRoots.length) throw new Error(`Expected source roots missing: ${missingRoots.join(', ')}`);
if (ids.size !== nodes.length || nodes.some((n) => !n.id)) throw new Error('Missing or duplicate node IDs.');
if (dangling.length) throw new Error(`Dangling edge endpoints: ${dangling.length}`);
if (nodes.some((n) => n._origin !== 'ast')) throw new Error('Non-AST nodes detected.');
if (added.length || changed.length || deleted.length) {
  const details = [...added.map((p) => `${p} (new)`), ...changed.map((p) => `${p} (hash changed)`),
    ...deleted.map((p) => `${p} (deleted)`)].slice(0, 8);
  throw new Error(`Graph is stale: ${added.length} new, ${changed.length} hash-changed, ` +
    `${deleted.length} deleted eligible files. ${details.join(', ')}`);
}
console.log(JSON.stringify({ graph: relative(repoRoot, graphPath), directed: graph.directed,
  nodes: nodes.length, edges: links.length, eligibleCodeFiles: files.length,
  newEligibleFiles: added.length, changedEligibleFiles: changed.length,
  deletedEligibleFiles: deleted.length, danglingEndpoints: dangling.length,
  prohibitedPaths: bad.length, coveredRoots: roots.length }, null, 2));

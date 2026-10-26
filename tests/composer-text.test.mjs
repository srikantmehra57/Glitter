import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-composer-text-'));
test.after(() => rm(temporary, { recursive: true, force: true }));

const outfile = join(temporary, 'composerText.mjs');
await build({ entryPoints: [resolve('apps/desktop/src/lib/composerText.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const lib = await import(pathToFileURL(outfile).href);

test('tab inserts an indent unit at a collapsed caret', () => {
  assert.deepEqual(lib.indentText('hello', 5, 5), { text: 'hello  ', start: 7, end: 7 });
  assert.deepEqual(lib.indentText('he|lo'.replace('|', ''), 2, 2), { text: 'he  lo', start: 4, end: 4 });
});

test('tab indents every selected line', () => {
  const edit = lib.indentText('one\ntwo\nthree', 0, 7);
  assert.equal(edit.text, '  one\n  two\nthree');
  assert.equal(edit.start, 2);
  assert.equal(edit.end, 11);
});

test('a selection ending at column zero leaves that line alone', () => {
  const edit = lib.indentText('one\ntwo', 0, 4);
  assert.equal(edit.text, '  one\ntwo');
});

test('shift+tab removes one indent level per line', () => {
  const edit = lib.outdentText('  one\n  two', 0, 11);
  assert.equal(edit.text, 'one\ntwo');
  assert.deepEqual([edit.start, edit.end], [0, 7]);
});

test('shift+tab tolerates tabs and uneven spaces', () => {
  assert.equal(lib.outdentText('\tone', 0, 4).text, 'one');
  assert.equal(lib.outdentText(' one', 0, 4).text, 'one');
  assert.equal(lib.outdentText('one', 0, 3).text, 'one');
});

test('shift+enter preserves plain indentation', () => {
  const edit = lib.continuationForEnter('  hello', 7);
  assert.equal(edit.text, '  hello\n  ');
  assert.equal(edit.start, 10);
});

test('shift+enter continues ordered lists with the next number', () => {
  assert.equal(lib.continuationForEnter('1. first', 8).text, '1. first\n2. ');
  assert.equal(lib.continuationForEnter('  3. deep', 9).text, '  3. deep\n  4. ');
  assert.equal(lib.continuationForEnter('2) paren', 8).text, '2) paren\n3) ');
});

test('shift+enter continues bullets and task items', () => {
  assert.equal(lib.continuationForEnter('- item', 6).text, '- item\n- ');
  assert.equal(lib.continuationForEnter('* item', 6).text, '* item\n* ');
  assert.equal(lib.continuationForEnter('  - [ ] todo', 12).text, '  - [ ] todo\n  - [ ] ');
});

test('shift+enter on an empty list item exits the list', () => {
  const edit = lib.continuationForEnter('1. buy milk\n2. ', 14);
  assert.equal(edit.text, '1. buy milk\n');
  assert.equal(edit.start, 12);
  const bullet = lib.continuationForEnter('  - ', 4);
  assert.equal(bullet.text, '  ');
});

test('shift+enter splits mid-line content after the marker', () => {
  const edit = lib.continuationForEnter('1. one two', 6);
  assert.equal(edit.text, '1. one\n2.  two');
});

test('current word requires a minimum length and a word boundary', () => {
  assert.equal(lib.currentWord('hel', 3)?.word, 'hel');
  assert.equal(lib.currentWord('h', 1), null);
  assert.equal(lib.currentWord('hello world', 3), null);
  assert.equal(lib.currentWord('(useEffect)', 10)?.word, 'useEffect');
  assert.equal(lib.currentWord('useEffect(', 10), null);
});

test('completion matches case-insensitively and skips exact matches', () => {
  assert.equal(lib.findUniqueCompletion('compo', ['Button', 'composer', 'compact']), 'composer');
  assert.equal(lib.findUniqueCompletion('Button', ['button', 'buttons']), 'buttons');
  assert.equal(lib.findUniqueCompletion('zzz', ['apple']), null);
});

test('completion stays silent on ambiguous prefixes', () => {
  assert.equal(lib.findUniqueCompletion('comp', ['composer', 'compact']), null);
  assert.equal(lib.findUniqueCompletion('comp', ['Composer', 'COMPACT']), null);
  assert.equal(lib.findUniqueCompletion('src/comp', ['src/composer.ts']), 'src/composer.ts');
});

test('candidates dedupe with most-recent spelling first', () => {
  const words = lib.collectCandidates(['newest Mention', 'older mention here']);
  assert.ok(words.includes('Mention'));
  assert.equal(words.filter((word) => word.toLowerCase() === 'mention').length, 1);
  assert.ok(!words.includes('is') && !words.includes('an'));
});

test('candidates skip common stop words', () => {
  const words = lib.collectCandidates(['the theme and its variants']);
  assert.ok(!words.includes('the') && !words.includes('and') && !words.includes('its'));
  assert.ok(words.includes('theme') && words.includes('variants'));
  assert.equal(lib.isStopWord('The'), true);
  assert.equal(lib.isStopWord('theme'), false);
});

test('slash queries only match at the start of the current line', () => {
  assert.deepEqual(lib.slashQuery('/ex', 3), { start: 0, query: 'ex' });
  assert.deepEqual(lib.slashQuery('  /fix', 6), { start: 2, query: 'fix' });
  assert.equal(lib.slashQuery('a / b', 5), null);
  assert.equal(lib.slashQuery('use /path', 9), null);
  assert.equal(lib.slashQuery('/done now', 5), null);
});

test('slash filtering prefers prefix matches', () => {
  const names = lib.filterSlashCommands('ex').map((command) => command.name);
  assert.equal(names[0], 'explain');
  assert.ok(lib.filterSlashCommands('').length > 0);
  assert.ok(lib.filterSlashCommands('zzz').length === 0);
});

test('built-in commands come first and every slash name appears once', () => {
  const builtins = lib.availableBuiltins({ thread: true, muse: true, live: true });
  const skills = [{ selector: '/plan', description: 'Plan with the planner skill', argumentHint: '<goal>' }, { selector: '/deploy' }];
  const all = lib.filterSlashCommands('', skills, builtins);
  const names = all.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, 'no name is listed twice');
  assert.deepEqual(all.slice(0, builtins.length).map((entry) => entry.kind), builtins.map(() => 'builtin'));
  assert.equal(all.find((entry) => entry.name === 'plan').kind, 'skill', 'a skill replaces the macro of the same name');
  assert.equal(all.find((entry) => entry.name === 'plan').argumentHint, '<goal>');
  assert.equal(all.find((entry) => entry.name === 'review').kind, 'builtin');
  assert.equal(all.find((entry) => entry.name === 'explain').kind, 'macro');
  assert.ok(all.length > 6, 'the list is no longer capped at six');
  assert.deepEqual(lib.filterSlashCommands('co', skills, builtins).map((entry) => entry.name).slice(0, 1), ['compact']);
  // A real review skill wins over the built-in, which only drafts a prompt.
  const withReview = lib.filterSlashCommands('review', [{ selector: '/review' }], builtins);
  assert.deepEqual(withReview.filter((entry) => entry.name === 'review').map((entry) => entry.kind), ['skill']);
  // An app action keeps its name even if a skill shares it.
  assert.deepEqual(lib.filterSlashCommands('new', [{ selector: '/new' }], builtins).map((entry) => entry.kind), ['builtin']);
});

test('built-ins that could do nothing are left out', () => {
  const names = (context) => lib.availableBuiltins(context).map((command) => command.name);
  const draft = names({ thread: false, muse: true, live: true });
  assert.ok(draft.includes('new') && draft.includes('model') && draft.includes('init'));
  assert.ok(!draft.includes('fork') && !draft.includes('rename') && !draft.includes('status') && !draft.includes('export'));
  const acp = names({ thread: true, muse: false, live: true });
  assert.ok(acp.includes('rename') && acp.includes('status'));
  assert.ok(!acp.includes('fork') && !acp.includes('compact') && !acp.includes('permissions') && !acp.includes('export'));
  const preview = names({ thread: true, muse: true, live: false });
  assert.ok(preview.includes('fork') && !preview.includes('compact') && !preview.includes('export'));
});

test('the review prompt follows the review scope', () => {
  assert.match(lib.reviewPrompt('all'), /uncommitted changes/);
  assert.match(lib.reviewPrompt('staged'), /staged changes/);
  assert.match(lib.reviewPrompt('unstaged'), /unstaged changes, including new files/);
  assert.match(lib.reviewPrompt('branch', ' main '), /since it diverged from main for/);
  assert.match(lib.reviewPrompt('branch', ''), /uncommitted changes/, 'no base falls back to all changes');
  assert.match(lib.reviewPrompt('lastTurn'), /your last turn/);
});

test('skill selectors normalize to one leading slash', () => {
  assert.equal(lib.skillSelectorText('review'), '/review');
  assert.equal(lib.skillSelectorText('/review'), '/review');
});

test('using a skill leads the invocation with the draft as arguments', () => {
  assert.equal(lib.skillUseText('review', ''), '/review ');
  assert.equal(lib.skillUseText('/review', '  '), '/review ');
  assert.equal(lib.skillUseText('review', 'src/auth.ts'), '/review src/auth.ts');
});

test('shell escape parses a leading bang with a command', () => {
  assert.deepEqual(lib.parseShellEscape('!git status'), { command: 'git status' });
  assert.deepEqual(lib.parseShellEscape('!  ls -la  '), { command: 'ls -la' });
  assert.deepEqual(lib.parseShellEscape('   !echo hi'), { command: 'echo hi' });
  assert.equal(lib.parseShellEscape('!'), null);
  assert.equal(lib.parseShellEscape('!   '), null);
  assert.equal(lib.parseShellEscape('plain text'), null);
  assert.equal(lib.parseShellEscape('run !echo'), null);
});

test('used skill text round-trips through invocation parsing', () => {
  assert.deepEqual(lib.parseSkillInvocation(lib.skillUseText('review', '')), { selector: 'review', args: '' });
  assert.deepEqual(lib.parseSkillInvocation(lib.skillUseText('review', 'src/auth.ts')), { selector: 'review', args: 'src/auth.ts' });
  assert.equal(lib.parseSkillInvocation('plain text'), null);
});

test('a drafted commit message yields its subject line without markdown dressing', () => {
  assert.equal(lib.commitSubjectFromReply('Fix login redirect loop\n\nThe guard ran twice.'), 'Fix login redirect loop');
  assert.equal(lib.commitSubjectFromReply("Here's a commit message:\n\n```\nAdd worktree threads\n\nBody text\n```\nLet me know."), 'Add worktree threads');
  assert.equal(lib.commitSubjectFromReply('**Tidy imports**'), 'Tidy imports');
  assert.equal(lib.commitSubjectFromReply('> `chore: bump deps`'), 'chore: bump deps');
  assert.equal(lib.commitSubjectFromReply('   \n'), '');
  assert.ok(lib.commitSubjectFromReply('x'.repeat(500)).length <= 200);
  assert.match(lib.COMMIT_DRAFT_PROMPT, /Reply with only the commit message/);
  assert.match(lib.commitDraftPrompt(false), /only my staged changes/);
  assert.match(lib.commitDraftPrompt(true), /staged and unstaged changes/);
});

test('custom commands sit between skills and macros, validate their names and place the caret at $ARGUMENTS', () => {
  const custom = [{ name: 'standup', description: 'Daily update', body: 'Summarize commits since $ARGUMENTS as a standup.' }, { name: 'plan', description: '', body: 'My plan prompt' }, { name: 'new', description: '', body: 'shadowed' }, { name: 'deploy', description: '', body: 'shadowed by a skill' }];
  const builtins = lib.availableBuiltins({ thread: true, muse: true, live: true });
  const all = lib.filterSlashCommands('', [{ selector: '/deploy' }], builtins, custom);
  const kind = (name) => all.filter((entry) => entry.name === name).map((entry) => entry.kind);
  assert.deepEqual(kind('standup'), ['custom']);
  assert.deepEqual(kind('plan'), ['custom'], 'a custom command replaces the macro of the same name');
  assert.deepEqual(kind('new'), ['builtin']); assert.deepEqual(kind('deploy'), ['skill']);
  assert.ok(all.findIndex((entry) => entry.kind === 'custom') > all.findIndex((entry) => entry.kind === 'skill'));
  assert.deepEqual(lib.filterSlashCommands('daily', [], [], custom).map((entry) => entry.name), ['standup']);
  assert.deepEqual(lib.customCommandInsert('Since $ARGUMENTS, and again $ARGUMENTS.'), { text: 'Since , and again .', caret: 6 });
  assert.deepEqual(lib.customCommandInsert('No slot'), { text: 'No slot', caret: 7 });
  const ok = { name: 'ship-it', description: '', body: 'Ship' };
  assert.equal(lib.customCommandProblem(ok, []), null);
  assert.match(lib.customCommandProblem({ ...ok, name: 'Ship It' }, []), /lowercase/);
  assert.match(lib.customCommandProblem({ ...ok, name: 'compact' }, []), /built-in/);
  assert.match(lib.customCommandProblem(ok, [ok]), /already exists/);
  assert.match(lib.customCommandProblem({ ...ok, body: '  ' }, []), /Write the prompt/);
  assert.deepEqual(lib.normalizeCustomCommands([ok, ok, { name: '../x', body: 'bad' }, { name: 'empty', body: '' }, null, 'text']), [ok]);
  assert.deepEqual(lib.normalizeCustomCommands('nope'), []);
});


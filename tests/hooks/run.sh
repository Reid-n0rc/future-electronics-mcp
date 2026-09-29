#!/bin/sh
# Tests for .githooks/pre-commit, .githooks/pre-push, and
# .claude/hooks/guard-git-push.sh.
#
# Everything runs in throwaway repos and a local bare remote under a temp
# dir. Nothing touches the real origin, and no network is used.
# Usage: sh tests/hooks/run.sh
#        HOOK_SHELL=dash sh tests/hooks/run.sh   (run the guard under dash)

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOOKS="$ROOT/.githooks"
GUARD="$ROOT/.claude/hooks/guard-git-push.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hooks-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
not_ok() { fail=$((fail + 1)); echo "FAIL - $1"; }

# expect <allow|block> <description> <command...>
expect() {
    want=$1
    desc=$2
    shift 2
    if "$@" >"$TMP/out" 2>&1; then got=allow; else got=block; fi
    # A block only counts if a hook produced it, not some unrelated error.
    if [ "$got" = block ] && ! grep -q -e "refusing to" -e "Blocked by" "$TMP/out"; then
        got="error (no hook message)"
    fi
    if [ "$got" = "$want" ]; then ok "$desc"; else not_ok "$desc (wanted $want, got $got)"; fi
    # Show hook output on failure, or always with HOOKS_TEST_VERBOSE=1.
    if [ "$got" != "$want" ] || [ -n "${HOOKS_TEST_VERBOSE:-}" ]; then sed 's/^/     /' "$TMP/out"; fi
}

# A key-looking value, built at runtime so this file never contains one.
FAKE_KEY="abcd""1234""EFGH""5678""ijkl"

# --- Setup --------------------------------------------------------------------
REPO="$TMP/repo"
REMOTE="$TMP/remote.git"
git init -q --bare "$REMOTE"
git init -q "$REPO"
g() { git -C "$REPO" "$@"; }
g config user.email test@example.com
g config user.name Test
g config commit.gpgsign false
g config core.hooksPath "$HOOKS"
g remote add origin "$REMOTE"
g switch -q -c issue-x
echo init >"$REPO/README"
g add README
g commit -q --no-verify -m init

# commit_file <path> <content>: stage one file and try to commit it.
commit_file() {
    mkdir -p "$(dirname "$REPO/$1")"
    printf '%s\n' "$2" >"$REPO/$1"
    g add -f -- "$1"
    g commit -q -m "add $1"
}
# Unstage and drop anything left over from a blocked commit.
reset_repo() {
    g reset -q --hard
    g clean -qfdx
}

# --- pre-commit: protected branches ---------------------------------------------
for b in dev master; do
    g switch -q -c "$b"
    expect block "pre-commit blocks commits on $b" commit_file "on-$b.txt" hello
    reset_repo
    g switch -q issue-x
done
expect allow "pre-commit allows commits on issue-x" commit_file ok.txt hello

# --- pre-commit: .env files ---------------------------------------------------------
mkdir -p "$REPO/sub"
for f in .env .env.local .env.production sub/.env; do
    expect block "pre-commit blocks staged $f" commit_file "$f" "A=1"
    reset_repo
done
expect allow "pre-commit allows .env.example" commit_file .env.example "FUTURE_API_KEY="
expect allow "pre-commit allows a file named env.txt" commit_file env.txt "x"

# --- pre-commit: key assignments -------------------------------------------------
n=0
check_line() {
    n=$((n + 1))
    expect "$1" "pre-commit $1s: $3" commit_file "key$n.txt" "$2"
    reset_repo
}
check_line block "FUTURE_API_KEY=$FAKE_KEY" "FUTURE_API_KEY=<fake key>"
check_line block "export FUTURE_API_KEY=\"$FAKE_KEY\"" "export FUTURE_API_KEY=\"<fake key>\""
check_line block "FUTURE_API_KEY: '$FAKE_KEY'" "FUTURE_API_KEY: '<fake key>'"
check_line block "curl -H \"x-orbweaver-licensekey: $FAKE_KEY\" https://example.invalid" "curl -H x-orbweaver-licensekey header"
check_line block "headers: { \"x-orbweaver-licensekey\": \"$FAKE_KEY\" }" "JS header object with a literal key"
check_line block "X-Orbweaver-LicenseKey: $FAKE_KEY" "mixed-case header name"
check_line block "future_api_key = \"$FAKE_KEY\"" "lower-case name with spaces"
check_line block "a=1; FUTURE_API_KEY=\"\$X\" x-orbweaver-licensekey: $FAKE_KEY" "second match on the same line"

check_line allow "claude mcp add future-electronics -e FUTURE_API_KEY=\"\$FUTURE_API_KEY\" -- node dist/index.js" "README mcp add line"
check_line allow "export FUTURE_API_KEY=\"…\"   # never commit this" "README export line with ellipsis"
check_line allow "FUTURE_API_KEY=\${FUTURE_API_KEY}" "\${FUTURE_API_KEY}"
check_line allow "FUTURE_API_KEY=your-key-here" "your-key-here"
check_line allow "FUTURE_API_KEY=test-key" "test-key"
check_line allow "\"x-orbweaver-licensekey\": \"test-key\"" "JS header with test-key"
check_line allow "x-orbweaver-licensekey: <value>" "<value>"
check_line allow "x-orbweaver-licensekey: [APIkey]" "[APIkey]"
check_line allow "FUTURE_API_KEY=" "empty value"
check_line allow "FUTURE_API_KEY=\"\"" "empty quoted value"
check_line allow "headers: { \"x-orbweaver-licensekey\": apiKey }" "JS header set from an identifier"
check_line allow "const key = process.env.FUTURE_API_KEY;" "process.env read"
check_line allow "The key comes only from FUTURE_API_KEY at runtime." "prose mention"
check_line allow "FUTURE_API_KEY=short" "short value under 8 chars"

# Only added lines are scanned: removing a key line must be allowed.
printf 'FUTURE_API_KEY=%s\n' "$FAKE_KEY" >"$REPO/old.txt"
g add old.txt
g commit -q --no-verify -m "seed (bypassed)"
: >"$REPO/old.txt"
g add old.txt
expect allow "pre-commit ignores removed lines" g commit -q -m "remove key line"

# --- pre-push -------------------------------------------------------------------
expect allow "pre-push allows pushing issue-x" g push -q origin issue-x
expect block "pre-push blocks HEAD:dev" g push -q origin HEAD:dev
expect block "pre-push blocks HEAD:refs/heads/master" g push -q origin HEAD:refs/heads/master
g branch -q -f dev issue-x
expect block "pre-push blocks pushing local dev" g push -q origin dev
expect block "pre-push blocks a mixed push that includes dev" g push -q origin issue-x dev
expect allow "pre-push allows issue-x:issue-y" g push -q origin issue-x:issue-y
expect allow "pre-push allows dev with ALLOW_PROTECTED_PUSH=1" env ALLOW_PROTECTED_PUSH=1 git -C "$REPO" push -q origin dev
if git -C "$REMOTE" rev-parse -q --verify refs/heads/master >/dev/null; then
    not_ok "bare remote has no master after blocked pushes"
else
    ok "bare remote has no master after blocked pushes"
fi

# --- guard-git-push.sh ---------------------------------------------------------------
DEVREPO="$TMP/on-dev"
git init -q "$DEVREPO"
git -C "$DEVREPO" symbolic-ref HEAD refs/heads/dev

# guard <allow|block> <cwd> <command>
guard() {
    json=$(jq -n --arg c "$3" --arg d "$2" '{tool_name: "Bash", cwd: $d, tool_input: {command: $c}}')
    run_guard() { printf '%s' "$json" | ${HOOK_SHELL:-sh} "$GUARD"; }
    expect "$1" "guard $1s: $3" run_guard
}
guard block "$REPO" "git push origin dev"
guard block "$REPO" "git push origin master"
guard block "$REPO" "git push origin HEAD:dev"
guard block "$REPO" "git push origin \"HEAD:dev\""
guard block "$REPO" "git push -u origin issue-x:refs/heads/master"
guard block "$REPO" "git push origin :dev"
guard block "$REPO" "git push --delete origin dev"
guard block "$REPO" "git push --force origin issue-x"
guard block "$REPO" "git push -f origin issue-x"
guard block "$REPO" "git push -fu origin issue-x"
guard block "$REPO" "git push origin +issue-x"
guard block "$REPO" "git push --force --force-with-lease origin issue-x"
guard block "$REPO" "git push --force-with-lease origin feature"
guard block "$REPO" "git push --force-with-lease origin issue-x:dev"
guard block "$REPO" "git push --all origin"
guard block "$REPO" "git push --mirror origin"
guard block "$REPO" "npm test && git push origin dev"
guard block "$REPO" "git -C /some/path push origin dev"
guard block "$DEVREPO" "git push"
guard block "$DEVREPO" "git push origin"
guard block "$DEVREPO" "git push origin HEAD"
guard block "$DEVREPO" "git push --force-with-lease"

guard allow "$REPO" "git push -u origin issue-x"
guard allow "$REPO" "git push origin issue-9-local-guardrails"
guard allow "$REPO" "git push --force-with-lease origin issue-x"
guard allow "$REPO" "git push --force-with-lease=issue-x:abc123 origin issue-x"
guard allow "$REPO" "git push --force-with-lease"
guard allow "$REPO" "git push"
guard allow "$REPO" "git push origin HEAD"
guard allow "$REPO" "git status && git log --oneline -3"
guard allow "$REPO" "git fetch origin dev"
guard allow "$REPO" "git switch dev"
guard allow "$REPO" "echo push dev"
guard allow "$REPO" "git push -o"

# Non-Bash payloads and bad input fail open (with a warning).
guard_raw() { printf '%s' "$1" | ${HOOK_SHELL:-sh} "$GUARD"; }
expect allow "guard allows input with no command" guard_raw '{"tool_name":"Read","tool_input":{"file_path":"x"}}'
expect allow "guard allows unparseable input" guard_raw 'not json'

# Without jq the guard allows and warns on stderr.
NOJQ="$TMP/nojq-bin"
mkdir -p "$NOJQ"
for tool in cat git tr sh; do ln -s "$(command -v "$tool")" "$NOJQ/$tool"; done
nojq() { printf '{"tool_input":{"command":"git push origin dev"}}' | PATH="$NOJQ" "$NOJQ/sh" "$GUARD"; }
expect allow "guard allows when jq is missing" nojq
if nojq 2>&1 | grep -q "jq not found"; then ok "guard warns when jq is missing"; else not_ok "guard warns when jq is missing"; fi

# Blocked output explains why on stderr.
reason=$(printf '%s' '{"tool_input":{"command":"git push origin dev"}}' | ${HOOK_SHELL:-sh} "$GUARD" 2>&1 >/dev/null)
case "$reason" in
    *"git push to dev"*) ok "guard prints the reason on stderr" ;;
    *) not_ok "guard prints the reason on stderr (got: $reason)" ;;
esac

# --- File modes ----------------------------------------------------------------------
for f in "$HOOKS/pre-commit" "$HOOKS/pre-push" "$GUARD"; do
    if [ -x "$f" ]; then ok "executable: ${f#"$ROOT"/}"; else not_ok "executable: ${f#"$ROOT"/}"; fi
done

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]

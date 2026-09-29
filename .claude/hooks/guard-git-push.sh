#!/bin/sh
# Claude Code PreToolUse hook for the Bash tool (wired in .claude/settings.json).
#
# Denies:
#   - git push whose target is master or dev (e.g. "origin dev",
#     "HEAD:dev", "feature:refs/heads/master", ":dev", or a bare "git push"
#     while the current branch is master or dev)
#   - git push --all / --mirror (they can update master and dev)
#   - any force push: --force, -f (also combined, e.g. -fu), or a +refspec
# Allows:
#   - --force-with-lease (and --force-if-includes) when every target branch
#     is an issue-* branch, because rebasing feature branches is normal.
#
# Protocol: reads the hook JSON on stdin. Exit 2 with a reason on stderr
# blocks the tool call; exit 0 lets it through. Requires jq. Without jq, or
# with unparseable input, the command is allowed and a warning is printed.

input=$(cat)

if ! command -v jq >/dev/null 2>&1; then
    echo "guard-git-push: jq not found; git push guard is disabled." >&2
    exit 0
fi

if ! cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null); then
    echo "guard-git-push: could not parse hook input; allowing." >&2
    exit 0
fi
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

[ -n "$cmd" ] || exit 0

deny() {
    echo "Blocked by .claude/hooks/guard-git-push.sh: $1" >&2
    echo "master and dev change only through pull requests (see AGENTS.md)." >&2
    exit 2
}

current_branch() {
    if [ -n "$cwd" ] && [ -d "$cwd" ]; then
        git -C "$cwd" symbolic-ref --short -q HEAD 2>/dev/null
    else
        git symbolic-ref --short -q HEAD 2>/dev/null
    fi
}

# Check one "git push" invocation. Arguments are the tokens after "push".
check_push() {
    force=0
    lease=0
    all=0
    remote=""
    targets=""
    have_refspec=0
    while [ $# -gt 0 ]; do
        arg=$1
        shift
        case "$arg" in
            --force) force=1 ;;
            --force-with-lease | --force-with-lease=* | --force-if-includes) lease=1 ;;
            --all | --mirror | --branches) all=1 ;;
            -o | --push-option | --repo | --receive-pack | --exec) [ $# -gt 0 ] && shift ;;
            --*) ;;
            -*f*) force=1 ;;
            -*) ;;
            *)
                if [ -z "$remote" ]; then
                    remote=$arg
                    continue
                fi
                have_refspec=1
                case "$arg" in
                    +*) force=1; arg=${arg#+} ;;
                esac
                case "$arg" in
                    *:*) dst=${arg##*:} ;;
                    *) dst=$arg ;;
                esac
                [ "$dst" = "HEAD" ] && dst=$(current_branch)
                dst=${dst#refs/heads/}
                targets="$targets $dst"
                ;;
        esac
    done

    [ "$all" = 1 ] && deny "git push --all/--mirror can update master or dev."

    if [ "$have_refspec" = 0 ]; then
        targets=$(current_branch)
    fi

    for t in $targets; do
        case "$t" in
            master | dev) deny "git push to $t." ;;
        esac
    done

    [ "$force" = 1 ] && deny "force push (--force, -f, or +refspec). Use --force-with-lease on an issue-* branch."

    if [ "$lease" = 1 ]; then
        [ -n "$targets" ] || deny "--force-with-lease with an unknown target branch."
        for t in $targets; do
            case "$t" in
                issue-*) ;;
                *) deny "--force-with-lease is only allowed on issue-* branches (target: $t)." ;;
            esac
        done
    fi
}

# Split the command into simple segments at ; & | ( ) and newlines, then
# look for "git [global options] push ..." in each segment.
segments=$(printf '%s\n' "$cmd" | tr ';&|()' '\n\n\n\n\n')

set -f
nl='
'
IFS=$nl
for seg in $segments; do
    IFS=' 	'
    # Drop simple quotes so "HEAD:dev" and 'dev' compare as plain words.
    seg=$(printf '%s' "$seg" | tr -d "\"'")
    set -- $seg
    while [ $# -gt 0 ] && [ "$1" != "git" ]; do shift; done
    [ $# -gt 0 ] || { IFS=$nl; continue; }
    shift
    # Skip git global options to find the subcommand.
    while [ $# -gt 0 ]; do
        case "$1" in
            -C | -c | --git-dir | --work-tree | --namespace)
                shift
                [ $# -gt 0 ] && shift
                ;;
            -*) shift ;;
            *) break ;;
        esac
    done
    if [ "${1:-}" = "push" ]; then
        shift
        check_push "$@"
    fi
    IFS=$nl
done

exit 0

# Oxytocin shell integration for fish (MIT), loaded from vendor_conf.d via XDG_DATA_DIRS. OSC 633 marks:
# A prompt start, B prompt end, E command line, C command start, D;<exit> command end, P;Cwd=<path>.
status is-interactive; or exit
set -q __oxy_si_loaded; and exit
set -g __oxy_si_loaded 1

# Give child processes the original XDG_DATA_DIRS back.
if set -q OXYTOCIN_XDG_DATA_DIRS
    if test -n "$OXYTOCIN_XDG_DATA_DIRS"
        set -gx XDG_DATA_DIRS (string split : -- $OXYTOCIN_XDG_DATA_DIRS)
    else
        set -e XDG_DATA_DIRS
    end
    set -e OXYTOCIN_XDG_DATA_DIRS
end

function __oxy_escape
    string replace -a -- '\\' '\\\\' "$argv" | string replace -a -- ';' '\x3b' | string replace -a -- \n '\x0a' | string replace -a -- \r '\x0d' | string replace -a -- \e '\x1b' | string replace -a -- \a '\x07' | string join '\x0a'
end

set -g __oxy_in_command 0

function __oxy_preexec --on-event fish_preexec
    set -g __oxy_in_command 1
    printf '\e]633;E;%s\a\e]633;C\a' (__oxy_escape "$argv")
end

function __oxy_postexec --on-event fish_postexec
    set -l code $status
    if test $__oxy_in_command = 1
        printf '\e]633;D;%s\a' $code
    end
    set -g __oxy_in_command 0
end

function __oxy_prompt --on-event fish_prompt
    printf '\e]633;P;Cwd=%s\a\e]633;A\a' (__oxy_escape "$PWD")
    # Wrap the prompt once (config.fish may have redefined it after this file was read) to mark its end.
    if not functions -q __oxy_original_prompt; and functions -q fish_prompt
        functions -c fish_prompt __oxy_original_prompt
        function fish_prompt
            __oxy_original_prompt
            printf '\e]633;B\a'
        end
    end
end

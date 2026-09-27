# Oxytocin shell integration for bash (MIT). Loaded with `bash --init-file <this file>`.
# Emits the OSC 633 marks (A prompt start, B prompt end, E command line, C command start, D;<exit> command end,
# P;Cwd=<path>) introduced by VS Code's shell integration protocol.

if [ -n "${__OXY_SI_LOADED:-}" ]; then return 0 2>/dev/null || exit 0; fi
__OXY_SI_LOADED=1

# --init-file replaces ~/.bashrc; a login shell (Oxytocin removes -l) reads the login files instead.
if [ "${OXYTOCIN_SHELL_LOGIN:-}" = "1" ]; then
  unset OXYTOCIN_SHELL_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  if [ -r "$HOME/.bash_profile" ]; then
    . "$HOME/.bash_profile"
  elif [ -r "$HOME/.bash_login" ]; then
    . "$HOME/.bash_login"
  elif [ -r "$HOME/.profile" ]; then
    . "$HOME/.profile"
  fi
else
  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
fi

# Only interactive shells with a terminal.
case "$-" in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac

# Escapes a value for OSC 633 into $__oxy_escaped (no subshell: the hooks must not fork processes).
__oxy_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//;/\\x3b}"
  s="${s//$'\n'/\\x0a}"
  s="${s//$'\r'/\\x0d}"
  s="${s//$'\e'/\\x1b}"
  s="${s//$'\a'/\\x07}"
  __oxy_escaped="$s"
}

__oxy_in_command=0
__oxy_at_prompt=0
__oxy_status=0

# First in PROMPT_COMMAND: sees the exit status of the command that just finished.
__oxy_precmd_start() {
  __oxy_status=$?
  __oxy_at_prompt=0
  if [ "$__oxy_in_command" = "1" ]; then
    printf '\e]633;D;%s\a' "$__oxy_status"
    __oxy_in_command=0
  fi
  return $__oxy_status
}

# Last in PROMPT_COMMAND: cwd and prompt marks around whatever PS1 the user's hooks produced.
__oxy_precmd_end() {
  __oxy_escape "$PWD"
  printf '\e]633;P;Cwd=%s\a' "$__oxy_escaped"
  if [[ "$PS1" != *'633;A'* ]]; then
    __oxy_ps1="$PS1"
  fi
  PS1='\[\e]633;A\a\]'"$__oxy_ps1"'\[\e]633;B\a\]'
  __oxy_at_prompt=1
}

__oxy_preexec() {
  [ "$__oxy_at_prompt" = "1" ] || return 0
  [ -n "${COMP_LINE:-}" ] && return 0
  case "$BASH_COMMAND" in __oxy_precmd_start*) return 0 ;; esac
  __oxy_at_prompt=0
  __oxy_in_command=1
  # The history line has the whole command line (pipelines, lists), unlike $BASH_COMMAND. Reading it takes
  # the hook's only subshell, which exits before the C mark (main never confirms a shell-named process early).
  local line
  line="$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line#*[0-9] }"
  line="${line#"${line%%[![:space:]]*}"}"
  [ -n "$line" ] || line="$BASH_COMMAND"
  __oxy_escape "$line"
  printf '\e]633;E;%s\a\e]633;C\a' "$__oxy_escaped"
}

if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__oxy_precmd_start "${PROMPT_COMMAND[@]}" __oxy_precmd_end)
else
  PROMPT_COMMAND="__oxy_precmd_start${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __oxy_precmd_end"
fi

# Command start/line: bash-preexec when present, otherwise a DEBUG trap (unless one is already installed).
if [ -n "${bash_preexec_imported:-}" ] || declare -F __bp_install >/dev/null 2>&1; then
  __oxy_bp_preexec() { __oxy_preexec; }
  preexec_functions+=(__oxy_bp_preexec)
elif [ -z "$(trap -p DEBUG)" ]; then
  trap '__oxy_preexec' DEBUG
fi

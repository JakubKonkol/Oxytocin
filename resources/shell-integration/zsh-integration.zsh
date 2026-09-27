# Oxytocin shell integration for zsh (MIT). OSC 633 marks: A prompt start, B prompt end, E command line,
# C command start, D;<exit> command end, P;Cwd=<path> (the protocol of VS Code's shell integration).
[[ -o interactive ]] || return 0
(( ${+__oxy_si_loaded} )) && return 0
typeset -g __oxy_si_loaded=1

__oxy_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//;/\\x3b}"
  s="${s//$'\n'/\\x0a}"
  s="${s//$'\r'/\\x0d}"
  s="${s//$'\e'/\\x1b}"
  s="${s//$'\a'/\\x07}"
  print -rn -- "$s"
}

typeset -g __oxy_in_command=0 __oxy_status=0 __oxy_ps1=""

# First precmd hook: the exit status of the command that just finished.
__oxy_capture() { __oxy_status=$?; }

# Last precmd hook: end mark, cwd and prompt marks around the PS1 other hooks produced.
__oxy_precmd() {
  if (( __oxy_in_command )); then
    print -rn -- $'\e]633;D;'"$__oxy_status"$'\a'
    __oxy_in_command=0
  fi
  print -rn -- $'\e]633;P;Cwd='"$(__oxy_escape "$PWD")"$'\a'
  [[ "$PS1" != *'633;A'* ]] && __oxy_ps1="$PS1"
  PS1=$'%{\e]633;A\a%}'"$__oxy_ps1"$'%{\e]633;B\a%}'
}

__oxy_preexec() {
  __oxy_in_command=1
  print -rn -- $'\e]633;E;'"$(__oxy_escape "$1")"$'\a\e]633;C\a'
}

autoload -Uz add-zsh-hook
precmd_functions=(__oxy_capture ${precmd_functions[@]})
add-zsh-hook precmd __oxy_precmd
add-zsh-hook preexec __oxy_preexec

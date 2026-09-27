# Oxytocin shell integration for zsh (MIT): ZDOTDIR points here; load the user's .zshenv, stay on our files.
if [[ -f "${USER_ZDOTDIR:-$HOME}/.zshenv" ]]; then
  __oxy_zdotdir="$ZDOTDIR"
  ZDOTDIR="${USER_ZDOTDIR:-$HOME}"
  . "$ZDOTDIR/.zshenv"
  USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$__oxy_zdotdir"
fi

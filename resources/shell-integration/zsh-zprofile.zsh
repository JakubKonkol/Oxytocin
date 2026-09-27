# Oxytocin shell integration for zsh (MIT): load the user's .zprofile (login shells).
if [[ -f "${USER_ZDOTDIR:-$HOME}/.zprofile" ]]; then
  __oxy_zdotdir="$ZDOTDIR"
  ZDOTDIR="${USER_ZDOTDIR:-$HOME}"
  . "$ZDOTDIR/.zprofile"
  USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$__oxy_zdotdir"
fi

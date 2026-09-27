# Oxytocin shell integration for zsh (MIT): load the user's .zshrc, then install the OSC 633 hooks.
__oxy_zdotdir="$ZDOTDIR"
if [[ -f "${USER_ZDOTDIR:-$HOME}/.zshrc" ]]; then
  ZDOTDIR="${USER_ZDOTDIR:-$HOME}"
  . "$ZDOTDIR/.zshrc"
  USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$__oxy_zdotdir"
fi
. "$__oxy_zdotdir/oxytocin.zsh"
# Login shells still read .zlogin from here; the others go back to the user's ZDOTDIR now.
if [[ ! -o login ]]; then
  ZDOTDIR="${USER_ZDOTDIR:-$HOME}"
  [[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR
  unset USER_ZDOTDIR
fi

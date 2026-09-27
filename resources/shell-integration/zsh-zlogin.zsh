# Oxytocin shell integration for zsh (MIT): load the user's .zlogin, then hand ZDOTDIR back.
ZDOTDIR="${USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zlogin" ]] && . "$ZDOTDIR/.zlogin"
[[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR
unset USER_ZDOTDIR

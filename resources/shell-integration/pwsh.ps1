# Oxytocin shell integration for PowerShell 5.1 / 7+ (MIT). Loaded with `-NoExit -Command ". '<this file>'"`
# after the user's profile. OSC 633 marks: A prompt start, B prompt end, E command line, C command start,
# D;<exit> command end, P;Cwd=<path> (the protocol of VS Code's shell integration).

if ($Global:__OxyShellIntegration) { return }
$Global:__OxyShellIntegration = $true

$Global:__OxyEsc = [char]27
$Global:__OxyBel = [char]7
$Global:__OxyOriginalPrompt = $function:prompt
$Global:__OxyLastHistoryId = -1
$Global:__OxyCommandStarted = $false
$Global:__OxyLastHistoryId = (Get-History -Count 1).Id
if ($null -eq $Global:__OxyLastHistoryId) { $Global:__OxyLastHistoryId = -1 }

function Global:__Oxy-Escape([string]$Value) {
  if ($null -eq $Value) { return '' }
  $Value.Replace('\', '\\').Replace(';', '\x3b').Replace("`n", '\x0a').Replace("`r", '\x0d').Replace([string][char]27, '\x1b').Replace([string][char]7, '\x07')
}

function Global:__Oxy-Mark([string]$Body) {
  "$Global:__OxyEsc]633;$Body$Global:__OxyBel"
}

function Global:prompt {
  # First statement: the success of the last command.
  $succeeded = $global:?
  $nativeCode = $global:LASTEXITCODE
  $out = ''
  $last = Get-History -Count 1
  $lastId = if ($null -ne $last) { $last.Id } else { -1 }
  if ($Global:__OxyCommandStarted -or $lastId -ne $Global:__OxyLastHistoryId) {
    if ($lastId -ne $Global:__OxyLastHistoryId) {
      $code = if ($succeeded) { 0 } elseif ($nativeCode) { $nativeCode } else { 1 }
      $out += __Oxy-Mark "D;$code"
    } else {
      # Enter on an empty line: the command start is closed without an exit code.
      $out += __Oxy-Mark 'D'
    }
  }
  $Global:__OxyCommandStarted = $false
  $Global:__OxyLastHistoryId = $lastId
  if ($PWD.Provider.Name -eq 'FileSystem') { $out += __Oxy-Mark "P;Cwd=$(__Oxy-Escape $PWD.ProviderPath)" }
  $out += __Oxy-Mark 'A'
  $original = if ($Global:__OxyOriginalPrompt) { & $Global:__OxyOriginalPrompt } else { "PS $($PWD.Path)> " }
  $out += ($original -join '')
  $out += __Oxy-Mark 'B'
  $global:LASTEXITCODE = $nativeCode
  return $out
}

# Command line and start: PSReadLine's Enter.
if (Get-Module -Name PSReadLine) {
  Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
    $line = $null
    $cursor = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    [Console]::Write((__Oxy-Mark "E;$(__Oxy-Escape $line)"))
    $Global:__OxyCommandStarted = $true
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    [Console]::Write((__Oxy-Mark 'C'))
  }
}

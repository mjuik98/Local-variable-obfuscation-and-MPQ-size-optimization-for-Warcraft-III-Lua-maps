param([Parameter(Mandatory=$true)][string]$SourcePath, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $OutputPath) { throw 'Desktop output already exists.' }
$source = [System.IO.File]::ReadAllText($SourcePath, [System.Text.Encoding]::UTF8)
Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $OutputPath -OutputType WindowsApplication -ReferencedAssemblies System.dll,System.Core.dll,System.Windows.Forms.dll,System.Drawing.dll,System.Web.Extensions.dll
if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) { throw 'Desktop compilation did not produce the executable.' }

# 用 Windows 自带的 .NET 生成一份 Word (.docx), 不依赖 python / Word。
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-docx.ps1 `
#     -Title "中国嵌入式芯片 2026 年四季度供货形势" -BodyFile body.txt -Out deliverables/report.docx
# body.txt: 纯文本, 空行分段, 以 "# " 开头的行是一级小标题。
# 版式: 正文宋体小四(12pt), 标题黑体三号(16pt)居中, 小标题宋体四号(14pt)加粗, 1.5 倍行距。

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$BodyFile,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

function Esc([string]$s) {
  $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')
}

function Para([string]$text, [string]$style) {
  $t = Esc $text
  if ($style -eq 'Title') {
    return "<w:p><w:pPr><w:pStyle w:val=`"Title`"/><w:jc w:val=`"center`"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii=`"SimHei`" w:eastAsia=`"SimHei`" w:hAnsi=`"SimHei`"/><w:b/><w:sz w:val=`"32`"/><w:szCs w:val=`"32`"/></w:rPr><w:t xml:space=`"preserve`">$t</w:t></w:r></w:p>"
  }
  if ($style -eq 'Heading1') {
    return "<w:p><w:pPr><w:pStyle w:val=`"Heading1`"/><w:spacing w:before=`"180`" w:after=`"80`"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii=`"SimSun`" w:eastAsia=`"SimSun`" w:hAnsi=`"SimSun`"/><w:b/><w:sz w:val=`"28`"/><w:szCs w:val=`"28`"/></w:rPr><w:t xml:space=`"preserve`">$t</w:t></w:r></w:p>"
  }
  return "<w:p><w:pPr><w:spacing w:line=`"360`" w:lineRule=`"auto`" w:after=`"80`"/><w:ind w:firstLine=`"480`"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii=`"SimSun`" w:eastAsia=`"SimSun`" w:hAnsi=`"SimSun`"/><w:sz w:val=`"24`"/><w:szCs w:val=`"24`"/></w:rPr><w:t xml:space=`"preserve`">$t</w:t></w:r></w:p>"
}

$lines = Get-Content -LiteralPath $BodyFile -Encoding UTF8
$body = New-Object System.Text.StringBuilder
[void]$body.Append((Para $Title 'Title'))
foreach ($raw in $lines) {
  $line = $raw.TrimEnd()
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line.StartsWith('# ')) {
    [void]$body.Append((Para $line.Substring(2).Trim() 'Heading1'))
  }
  else {
    [void]$body.Append((Para $line 'BodyText'))
  }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('docx-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $work '_rels') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $work 'word/_rels') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $work 'word') -Force | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

$contentTypes = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>
'@
$rels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>
'@
$docRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>
'@
$styles = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="SimSun" w:hAnsi="SimSun"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:outlineLvl w:val="0"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style></w:styles>
'@
$document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + $body.ToString() + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>'

[System.IO.File]::WriteAllText((Join-Path $work '[Content_Types].xml'), $contentTypes, $utf8)
[System.IO.File]::WriteAllText((Join-Path $work '_rels/.rels'), $rels, $utf8)
[System.IO.File]::WriteAllText((Join-Path $work 'word/_rels/document.xml.rels'), $docRels, $utf8)
[System.IO.File]::WriteAllText((Join-Path $work 'word/styles.xml'), $styles, $utf8)
[System.IO.File]::WriteAllText((Join-Path $work 'word/document.xml'), $document, $utf8)

$outFull = [System.IO.Path]::GetFullPath($Out)
$dir = Split-Path -Parent $outFull
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
if (Test-Path $outFull) { Remove-Item $outFull -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($work, $outFull)
Remove-Item $work -Recurse -Force
Write-Output ('WROTE:' + $outFull + ' (' + (Get-Item $outFull).Length + ' bytes)')

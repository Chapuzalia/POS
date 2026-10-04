$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$schemaDirectory = Join-Path $repo 'docs/fiscal/schemas'
$fixturesJson = & node (Join-Path $PSScriptRoot 'verifactu-xsd-fixtures.mjs')
if ($LASTEXITCODE -ne 0) { throw 'No se generaron las muestras XML fiscales.' }
$fixtures = $fixturesJson | ConvertFrom-Json

$schemas = [System.Xml.Schema.XmlSchemaSet]::new()
$schemas.XmlResolver = $null
$signatureSettings = [System.Xml.XmlReaderSettings]::new()
$signatureSettings.DtdProcessing = [System.Xml.DtdProcessing]::Parse
$signatureSettings.XmlResolver = $null
$signatureReader = [System.Xml.XmlReader]::Create((Join-Path $schemaDirectory 'xmldsig-core-schema.xsd'), $signatureSettings)
try { [void]$schemas.Add('http://www.w3.org/2000/09/xmldsig#', $signatureReader) }
finally { $signatureReader.Dispose() }
[void]$schemas.Add('https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd', (Join-Path $schemaDirectory 'SuministroInformacion-v1.0.xsd'))
$schemas.Compile()
if (-not $schemas.IsCompiled) { throw 'No se pudo compilar el XSD oficial.' }

foreach ($fixture in $fixtures) {
  $settings = [System.Xml.XmlReaderSettings]::new()
  $settings.ValidationType = [System.Xml.ValidationType]::Schema
  $settings.Schemas = $schemas
  $settings.XmlResolver = $null
  $settings.add_ValidationEventHandler({ param($sender, $eventArgs) throw $eventArgs.Message })
  $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($fixture.xml), $settings)
  try { while ($reader.Read()) {} }
  finally { $reader.Dispose() }
  Write-Output "$($fixture.name): XSD válido"
}

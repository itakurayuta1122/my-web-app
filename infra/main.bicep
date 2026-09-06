// リソースグループを作るため、サブスクリプションスコープで実行する
targetScope = 'subscription'

@description('リソースを作成するリージョン')
param location string = 'japanwest'

@description('リソースグループ名')
param resourceGroupName string = 'rg-container-cicd'

@description('ACR名（全世界で一意・小文字英数字のみ）')
param acrName string

@description('App Service Plan名')
param planName string

@description('Web App名（全世界で一意）')
param webAppName string

@description('App Service Plan の SKU')
@allowed([
  'F1'
  'B1'
])
param planSku string = 'F1'

@description('コンテナが待ち受けるポート')
param websitesPort string = '3000'

@description('初回構築時のプレースホルダイメージ。実リリースイメージはGitHub Actionsが設定する')
param bootstrapImage string = 'mcr.microsoft.com/azuredocs/aci-helloworld:latest'

// ---------------- リソースグループ ----------------
resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
}

// ---------------- RG内のリソース（module） ----------------
module resources 'modules/resources.bicep' = {
  name: 'container-resources'
  // ここで作ったRGをスコープに指定する。依存関係は自動で解決される
  scope: rg
  params: {
    location: location
    acrName: acrName
    planName: planName
    webAppName: webAppName
    planSku: planSku
    websitesPort: websitesPort
    bootstrapImage: bootstrapImage
  }
}

output resourceGroupNameOut string = rg.name
output acrLoginServer string = resources.outputs.acrLoginServer
output webAppUrl string = resources.outputs.webAppUrl
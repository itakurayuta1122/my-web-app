@description('リソースを作成するリージョン')
param location string

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

// ---------------- ACR ----------------
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    // マネージドID方式にするので管理者ユーザーは無効
    adminUserEnabled: false
  }
}

// ---------------- App Service Plan ----------------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  sku: {
    name: planSku
    tier: planSku == 'F1' ? 'Free' : 'Basic'
  }
  kind: 'linux'
  properties: {
    // Linux プランは reserved: true が必須
    reserved: true
  }
}

// ---------------- Web App (Container) ----------------
resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux,container'
  identity: {
    // ACR pull に使うシステム割り当てマネージドID
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      // 初回はACRにイメージが無いため実在するパブリックイメージを指定する。
      // 実リリースイメージは app-deploy.yml が上書きする。
      // ※ ACRのイメージを指す場合は acr.properties.loginServer から組み立てること
      //    （文字列を手打ちするとレジストリ名の二重付与が起きる）
      linuxFxVersion: 'DOCKER|${bootstrapImage}'
      // マネージドIDでACRからpullする
      acrUseManagedIdentityCreds: true
      // F1 は alwaysOn 不可
      alwaysOn: planSku == 'F1' ? false : true
      ftpsState: 'FtpsOnly'
      minTlsVersion: '1.2'
      appSettings: [
        {
          // コンテナが3000番で待ち受けるため、App Serviceへ転送先ポートを通知する
          name: 'WEBSITES_PORT'
          value: websitesPort
        }
        {
          // Application Insights を自動で付けない
          name: 'ApplicationInsightsAgent_EXTENSION_VERSION'
          value: 'disabled'
        }
      ]
    }
  }
}

// ---------------- ACR Pull ロール割り当て ----------------
// AcrPull の組み込みロールID（固定値）
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, webApp.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      acrPullRoleId
    )
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output acrLoginServer string = acr.properties.loginServer
output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
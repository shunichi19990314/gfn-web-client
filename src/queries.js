// GraphQLクエリ本体
// LIBRARY_QUERY: OpenNOW native/opennow-core/src/gfn.rs:184-210 より逐語移植
// LIBRARY_QUERY_V2: 上記 + variants.gfn.stateDetails / playStatus(旧Electron版 lcarsGraphql.ts:75-96 の
//   VariantGfnAutoPatchingMetadata 等のフラグメントに由来)。「ゲーム更新中」の事前検出用。
//   スキーマ不一致で拒否された場合は LIBRARY_QUERY へフォールバックする(fetchLibraryPage参照)。

const LIBRARY_ITEM_FIELDS = `
      id title developerName publisherName genres supportedControls
      images { KEY_ART KEY_IMAGE GAME_BOX_ART TV_BANNER HERO_IMAGE MARQUEE_HERO_IMAGE FEATURE_IMAGE GAME_LOGO SCREENSHOTS }
      variants {
        id appStore storeUrl supportedControls
        gfn {
          status
          features {
            __typename
            ... on GfnSubscriptionFeatureValue { key value }
            ... on GfnSubscriptionFeatureValueList { key values }
          }
          library { status selected lastPlayedDate }
        }
      }
      gfn { playType playabilityState minimumMembershipTierLabel catalogSkuStrings { SKU_BASED_TAG SKU_BASED_PLAYABILITY_TEXT } }
      itemMetadata { campaignIds }`;

const LIBRARY_ITEM_FIELDS_V2 = `
      id title developerName publisherName genres supportedControls
      images { KEY_ART KEY_IMAGE GAME_BOX_ART TV_BANNER HERO_IMAGE MARQUEE_HERO_IMAGE FEATURE_IMAGE GAME_LOGO SCREENSHOTS }
      variants {
        id appStore storeUrl supportedControls
        gfn {
          status
          features {
            __typename
            ... on GfnSubscriptionFeatureValue { key value }
            ... on GfnSubscriptionFeatureValueList { key values }
          }
          library { status selected lastPlayedDate playStatus installed }
          stateDetails {
            __typename
            ... on VariantGfnAutoPatchingMetadata { subType endTime }
            ... on VariantGfnManualPatchingMetadata { subType endTime }
            ... on VariantGfnMaintenanceMetadata { subType }
          }
        }
      }
      gfn { playType playabilityState minimumMembershipTierLabel catalogSkuStrings { SKU_BASED_TAG SKU_BASED_PLAYABILITY_TEXT } }
      itemMetadata { campaignIds }`;

function libraryQuery(itemFields) {
  return `query GetLibraryApps(
  $vpcId: String!, $locale: String!, $sortString: String!,
  $fetchCount: Int!, $cursor: String!, $filters: AppFilterFields!
) {
  apps(vpcId: $vpcId, language: $locale, orderBy: $sortString, first: $fetchCount, after: $cursor, filters: $filters) {
    numberReturned numberSupported pageInfo { hasNextPage endCursor totalCount }
    items {${itemFields}
    }
  }
}`;
}

export const LIBRARY_QUERY = libraryQuery(LIBRARY_ITEM_FIELDS);
export const LIBRARY_QUERY_V2 = libraryQuery(LIBRARY_ITEM_FIELDS_V2);

// GraphQLクエリ本体 — OpenNOW native/opennow-core/src/gfn.rs:184-210 (LIBRARY_QUERY) より逐語移植
export const LIBRARY_QUERY = `query GetLibraryApps(
  $vpcId: String!, $locale: String!, $sortString: String!,
  $fetchCount: Int!, $cursor: String!, $filters: AppFilterFields!
) {
  apps(vpcId: $vpcId, language: $locale, orderBy: $sortString, first: $fetchCount, after: $cursor, filters: $filters) {
    numberReturned numberSupported pageInfo { hasNextPage endCursor totalCount }
    items {
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
      itemMetadata { campaignIds }
    }
  }
}`;

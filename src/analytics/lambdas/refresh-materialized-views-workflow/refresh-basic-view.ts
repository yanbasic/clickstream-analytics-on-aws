/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import { logger } from '../../../common/powertools';
import { getRedshiftClient, executeStatements, getRedshiftProps } from '../redshift-data';

const REDSHIFT_DATA_API_ROLE_ARN = process.env.REDSHIFT_DATA_API_ROLE!;
const REDSHIFT_DATABASE = process.env.REDSHIFT_DATABASE!;

const redshiftDataApiClient = getRedshiftClient(REDSHIFT_DATA_API_ROLE_ARN);

export interface RefreshBasicViewEvent {
  detail: {
    viewName: string;
  };
  timezoneWithAppId: {
    appId: string;
    timezone: string;
  };
}

/**
 * The lambda function to refresh basic view in Redshift.
 * @param event RefreshBasicViewEvent, the JSON format is as follows:
 {
    "detail": {
      "viewName": view1
    }
  }
  @returns The query_id and relevant properties.
 */
export const handler = async (event: RefreshBasicViewEvent) => {

  const redshiftProps = getRedshiftProps(
    process.env.REDSHIFT_MODE!,
    REDSHIFT_DATABASE,
    REDSHIFT_DATA_API_ROLE_ARN,
    process.env.REDSHIFT_DB_USER!,
    process.env.REDSHIFT_SERVERLESS_WORKGROUP_NAME!,
    process.env.REDSHIFT_CLUSTER_IDENTIFIER!,
  );

  const sqlStatements: string[] = [];
  try {
    const timezoneWithAppId = event.timezoneWithAppId;
    const viewName = event.detail.viewName;
    sqlStatements.push(`REFRESH MATERIALIZED VIEW ${timezoneWithAppId.appId}.${viewName};`);

    logger.info('sqlStatements', { sqlStatements });
    const queryId = await executeStatements(
      redshiftDataApiClient, sqlStatements, redshiftProps.serverlessRedshiftProps, redshiftProps.provisionedRedshiftProps);

    logger.info(`Refresh mv for app: ${timezoneWithAppId.appId} is scheduled and viewName: ${viewName}`);
    return {
      detail: {
        queryId: queryId,
        viewName: viewName,
      },
      timezoneWithAppId,
    };
  } catch (err) {
    logger.error('Error when refresh mv:', { err });
    throw err;
  }
};
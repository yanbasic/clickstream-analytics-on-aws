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

import { AnalysisType, AttributionModelType, ExploreLocales, ExploreRequestAction, ExploreVisualName, QuickSightChartType } from '@aws/clickstream-base-lib';
import { v4 as uuidv4 } from 'uuid';
import { PipelineServ } from './pipeline';
import { DataSetProps } from './quicksight/dashboard-ln';
import { CreateDashboardResult, attributionVisualColumns, checkAttributionAnalysisParameter, encodeAttributionQueryValueForSql, getAttributionTableVisualDef, getDashboardTitleProps, getTempResourceName, getTimezoneByAppId, getVisualRelatedDefs } from './quicksight/reporting-utils';
import { AttributionSQLParameters, buildSQLForLinearModel, buildSQLForPositionModel, buildSQLForSinglePointModel } from './quicksight/sql-builder-attribution';
import { ReportingService } from './reporting';
import { logger } from '../common/powertools';
import { ApiFail, ApiSuccess } from '../common/types';
import { IPipeline } from '../model/pipeline';

const pipelineServ: PipelineServ = new PipelineServ();

export class AttributionAnalysisService {

  async createAttributionAnalysisVisual(req: any, res: any, next: any) {

    try {
      logger.info('start to create last touch model visuals', { request: req.body });

      const query = req.body;

      const checkResult = checkAttributionAnalysisParameter(query);
      if (!checkResult.success) {
        logger.debug(checkResult.message);
        return res.status(400).json(new ApiFail(checkResult.message));
      }
      const pipeline = await pipelineServ.getPipelineByProjectId(query.projectId);
      if (!pipeline) {
        return res.status(404).json(new ApiFail('Pipeline not found'));
      }
      query.timezone = getTimezoneByAppId(pipeline, query.appId);

      encodeAttributionQueryValueForSql(query as AttributionSQLParameters);

      let sheetId;
      if (!query.dashboardId) {
        sheetId = uuidv4();
      } else {
        if (!query.sheetId) {
          return res.status(400).send(new ApiFail('missing required parameter sheetId'));
        }
        sheetId = query.sheetId;
      }

      let result: CreateDashboardResult | undefined = undefined;
      if (query.modelType == AttributionModelType.LAST_TOUCH || query.modelType == AttributionModelType.FIRST_TOUCH) {
        result = await this.createSinglePointModelVisual(sheetId, query as AttributionSQLParameters, pipeline);
      } else if (query.modelType == AttributionModelType.LINEAR) {
        result = await this.createLinearModelVisual(sheetId, query as AttributionSQLParameters, pipeline);
      } else if (query.modelType == AttributionModelType.POSITION) {
        result = await this.createPositionBasedModelVisual(sheetId, query as AttributionSQLParameters, pipeline);
      } else {
        return res.status(400).send(new ApiFail('Invalid attribution analysis model type'));
      }

      if (result === undefined || result.dashboardEmbedUrl === '' && query.action === ExploreRequestAction.PREVIEW) {
        return res.status(500).json(new ApiFail('Failed to create resources, please try again later.'));
      }
      return res.status(201).json(new ApiSuccess(result));

    } catch (error) {
      next(error);
    }
  };

  async createSinglePointModelVisual(sheetId: string, query: any, pipeline: IPipeline) {
    const sql = buildSQLForSinglePointModel({
      ...query,
      schemaName: query.appId,
      dbName: query.projectId,
    } as AttributionSQLParameters);

    logger.debug(`sql of single point model: ${sql}`);

    return this.createModelVisual(sql, sheetId, query, pipeline);
  };

  async createLinearModelVisual(sheetId: string, query: any, pipeline: IPipeline) {
    const sql = buildSQLForLinearModel({
      ...query,
      schemaName: query.appId,
      dbName: query.projectId,
    } as AttributionSQLParameters);
    logger.debug(`sql of linear model: ${sql}`);

    return this.createModelVisual(sql, sheetId, query, pipeline);
  };

  async createPositionBasedModelVisual(sheetId: string, query: any, pipeline: IPipeline) {
    const sql = buildSQLForPositionModel({
      ...query,
      schemaName: query.appId,
      dbName: query.projectId,
    } as AttributionSQLParameters);
    logger.debug(`sql of position based model: ${sql}`);

    return this.createModelVisual(sql, sheetId, query, pipeline);
  };

  async createModelVisual(visualSql: string, sheetId: string, query: any, pipeline: IPipeline) {

    const viewName = getTempResourceName(query.viewName, query.action);

    const datasetPropsArray: DataSetProps[] = [];
    datasetPropsArray.push({
      tableName: viewName,
      columns: attributionVisualColumns,
      importMode: 'DIRECT_QUERY',
      customSql: visualSql,
      projectedColumns: [
        'Trigger Count',
        'Touch Point Name',
        'Number of Total Conversion',
        'Number of Triggers with Conversion',
        'Contribution(number/sum...value)',
        'Contribution Rate',
      ],
    });

    const locale = query.locale ?? ExploreLocales.EN_US;
    const visualId = uuidv4();
    const titleProps = await getDashboardTitleProps(AnalysisType.ATTRIBUTION, query);
    const quickSightChartType = query.chartType ?? QuickSightChartType.TABLE;
    const visualDef = getAttributionTableVisualDef(visualId, viewName, titleProps, quickSightChartType);
    const visualRelatedParams = await getVisualRelatedDefs({
      timeScopeType: query.timeScopeType,
      sheetId,
      visualId,
      viewName,
      lastN: query.lastN,
      timeUnit: query.timeUnit,
      timeStart: query.timeStart,
      timeEnd: query.timeEnd,
    }, locale);

    const visualProps = {
      sheetId: sheetId,
      name: ExploreVisualName.CHART,
      visualId: visualId,
      visual: visualDef,
      dataSetIdentifierDeclaration: [],
      filterControl: visualRelatedParams.filterControl,
      parameterDeclarations: visualRelatedParams.parameterDeclarations,
      filterGroup: visualRelatedParams.filterGroup,
    };

    return new ReportingService().createDashboardVisuals(sheetId, viewName, query, pipeline, datasetPropsArray, [visualProps]);

  };

}
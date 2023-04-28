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
import { DescribeStatementCommand, BatchExecuteStatementCommand, BatchExecuteStatementCommandInput, ExecuteStatementCommand, RedshiftDataClient, ExecuteStatementCommandInput } from '@aws-sdk/client-redshift-data';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CdkCustomResourceEvent, CdkCustomResourceCallback, CdkCustomResourceResponse } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { ResourcePropertiesType, handler, physicalIdPrefix } from '../../../../../src/analytics/lambdas/custom-resource/create-schemas';
import 'aws-sdk-client-mock-jest';
import { ProvisionedRedshiftProps } from '../../../../../src/analytics/private/model';
import { TABLE_NAME_ODS_EVENT } from '../../../../../src/common/constant';
import { getMockContext } from '../../../../common/lambda-context';
import { basicCloudFormationEvent } from '../../../../common/lambda-events';

describe('Custom resource - Create schemas for applications in Redshift database', () => {

  const context = getMockContext();
  const callback: CdkCustomResourceCallback = async (_response) => {};

  const redshiftDataMock = mockClient(RedshiftDataClient);
  const ssmMock = mockClient(SSMClient);

  const projectDBName = 'clickstream_project1';
  const roleName = 'MyRedshiftDBUserRole';
  const biUserNamePrefix = 'clickstream_report_user_';
  const basicEvent = {
    ...basicCloudFormationEvent,
    ResourceProperties: {
      ...basicCloudFormationEvent.ResourceProperties,
      ServiceToken: 'token-1',
      projectId: 'project1',
      odsTableName: 'ods_events',
      databaseName: projectDBName,
      dataAPIRole: `arn:aws:iam::1234567890:role/${roleName}`,
      redshiftBIUserParameter: '/clickstream/report/user/1111',
      redshiftBIUsernamePrefix: biUserNamePrefix,
    },
  };

  const workgroupName = 'demo';
  const defaultDBName = 'defaultDB';
  const createSchemaPropsInServerless: ResourcePropertiesType = {
    ...basicEvent.ResourceProperties,
    appIds: 'app1',
    serverlessRedshiftProps: {
      workgroupName: workgroupName,
      databaseName: defaultDBName,
      dataAPIRoleArn: 'arn:aws:iam::1234567890:role/RedshiftDBUserRole',
    },
  };
  const createServerlessEvent = {
    ...basicEvent,
    ResourceProperties: createSchemaPropsInServerless,
  };

  const updateServerlessEvent: CdkCustomResourceEvent = {
    ...createServerlessEvent,
    OldResourceProperties: createServerlessEvent.ResourceProperties,
    ResourceProperties: {
      ...createServerlessEvent.ResourceProperties,
      appIds: 'app2',
    },
    PhysicalResourceId: `${physicalIdPrefix}abcde`,
    RequestType: 'Update',
  };

  const clusterId = 'redshift-cluster-1';
  const dbUser = 'aDBUser';
  const provisionedRedshiftProps: ProvisionedRedshiftProps = {
    clusterIdentifier: clusterId,
    dbUser: dbUser,
    databaseName: defaultDBName,
  };
  const createProvisionedEvent = {
    ...basicEvent,
    ResourceProperties: {
      ...basicEvent.ResourceProperties,
      appIds: 'app1',
      provisionedRedshiftProps,
    },
  };

  const updateAdditionalProvisionedEvent: CdkCustomResourceEvent = {
    ...createProvisionedEvent,
    OldResourceProperties: createProvisionedEvent.ResourceProperties,
    ResourceProperties: {
      ...createProvisionedEvent.ResourceProperties,
      appIds: 'app1,app2',
    },
    PhysicalResourceId: 'physical-resource-id',
    RequestType: 'Update',
  };

  beforeEach(() => {
    redshiftDataMock.reset();
    ssmMock.reset();
  });

  test('Only creating database and bi user are invoked if no application is given', async () => {
    ssmMock.onAnyCommand().resolves({});
    const eventWithoutApp = {
      ...createServerlessEvent,
      ResourceProperties: {
        ...createServerlessEvent.ResourceProperties,
        appIds: '',
      },
    };
    redshiftDataMock.on(ExecuteStatementCommand).resolves({ Id: 'Id-1' });
    redshiftDataMock.on(BatchExecuteStatementCommand).resolves({ Id: 'Id-2' });
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });
    const resp = await handler(eventWithoutApp, context, callback) as CdkCustomResourceResponse;
    expect(resp.Status).toEqual('SUCCESS');
    expect(redshiftDataMock).toHaveReceivedCommandTimes(ExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedNthSpecificCommandWith(1, ExecuteStatementCommand, {
      Sql: `CREATE DATABASE ${projectDBName};`,
      WorkgroupName: workgroupName,
      Database: defaultDBName,
      ClusterIdentifier: undefined,
      DbUser: undefined,
    });
    expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 2);
  });

  test('BI user is created in creation event', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    const eventWithoutApp = {
      ...createServerlessEvent,
      ResourceProperties: {
        ...createServerlessEvent.ResourceProperties,
        appIds: '',
      },
    };
    redshiftDataMock.on(ExecuteStatementCommand).resolvesOnce({ Id: 'id-1' })
      .callsFake(input => {
        if (input as ExecuteStatementCommandInput) {
          if (input.Sql.includes('CREATE USER')) {
            return { Id: 'id-2' };
          }
        }
        throw new Error('Sqls are not expected');
      }).resolves({ Id: 'Id-1' });
    redshiftDataMock.on(BatchExecuteStatementCommand).resolves({ Id: 'Id-2' });
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });
    const resp = await handler(eventWithoutApp, context, callback) as CdkCustomResourceResponse;
    expect(resp.Status).toEqual('SUCCESS');
    expect(ssmMock).toHaveReceivedCommandTimes(PutParameterCommand, 1);
    expect(redshiftDataMock).toHaveReceivedCommandTimes(ExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 2);
  });

  test('Created bi user with lower case characters only', async () => {
    ssmMock.onAnyCommand().resolves({});
    const regex = new RegExp(`^CREATE USER ${biUserNamePrefix}[a-z0-9]{8} PASSWORD 'md5[a-f0-9]{32}'$`);
    redshiftDataMock.on(ExecuteStatementCommand).resolvesOnce({ Id: 'Id-1' })
      .callsFakeOnce(input => {
        if (input as ExecuteStatementCommandInput && regex.test(input.Sql)) {
          return 'Id-2';
        }
        throw new Error(`Sql '${input.Sql}' are not expected, the bi user does not meet the pattern.`);
      });
    redshiftDataMock.on(BatchExecuteStatementCommand).resolves({ Id: 'Id-2' });
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });
    const resp = await handler(createServerlessEvent, context, callback) as CdkCustomResourceResponse;
    expect(resp.Status).toEqual('SUCCESS');
  });

  test('Created database, bi user, schemas and views in Redshift serverless', async () => {
    ssmMock.onAnyCommand().resolves({});
    redshiftDataMock.on(ExecuteStatementCommand).resolves({ Id: 'Id-1' });
    redshiftDataMock.on(BatchExecuteStatementCommand).callsFakeOnce(input => {
      if (input as BatchExecuteStatementCommandInput) {
        if (input.Sqls.length >= 2 && input.Sqls[0].includes('CREATE SCHEMA IF NOT EXISTS app1')
        && input.Sqls[1].includes(`CREATE TABLE IF NOT EXISTS app1.${TABLE_NAME_ODS_EVENT}(`)) {
          return { Id: 'Id-1' };
        }
      }
      throw new Error(`Sqls '${input.Sqls}' are not expected`);
    }).callsFakeOnce(input => {
      if (input as BatchExecuteStatementCommandInput) {
        for (const sql of input.Sqls) {
          if (sql.includes('####.ods_events')) {
            throw new Error(`The SQL '${sql}' contains the placeholder!`);
          }
        }
      }
      return 'Id-22';
    });
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });
    const resp = await handler(createServerlessEvent, context, callback) as CdkCustomResourceResponse;
    expect(resp.Status).toEqual('SUCCESS');
    expect(redshiftDataMock).toHaveReceivedCommandTimes(ExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedNthSpecificCommandWith(1, BatchExecuteStatementCommand, {
      Sqls: expect.arrayContaining([
        expect.stringMatching(`GRANT USAGE ON SCHEMA "app1" TO "${biUserNamePrefix}\\w{8}";`),
      ]),
    });
    expect(redshiftDataMock).toHaveReceivedNthSpecificCommandWith(1, ExecuteStatementCommand, {
      Sql: `CREATE DATABASE ${projectDBName};`,
      WorkgroupName: workgroupName,
      Database: defaultDBName,
      ClusterIdentifier: undefined,
      DbUser: undefined,
    });
    expect(redshiftDataMock).toHaveReceivedNthSpecificCommandWith(1, BatchExecuteStatementCommand, {
      WorkgroupName: workgroupName,
      Database: projectDBName,
      ClusterIdentifier: undefined,
      DbUser: undefined,
    });
    expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 4);
  });

  test('Created database, bi user, schemas and views in Redshift serverless - check status multiple times to wait success', async () => {
    ssmMock.onAnyCommand().resolves({});
    redshiftDataMock.on(ExecuteStatementCommand).resolves({ Id: 'Id-1' });
    redshiftDataMock.on(BatchExecuteStatementCommand).resolves({ Id: 'Id-2' });
    redshiftDataMock.on(DescribeStatementCommand)
      .resolvesOnce({ Status: 'FINISHED' }) // create db
      .resolvesOnce({ Status: 'FINISHED' }) // create bi user
      .resolvesOnce({ Status: 'STARTED' }) // create schemas
      .resolvesOnce({ Status: 'FINISHED' })
      .resolves({ Status: 'FINISHED' }); // create views
    const resp = await handler(createServerlessEvent, context, callback) as CdkCustomResourceResponse;
    expect(resp.Status).toEqual('SUCCESS');
    expect(redshiftDataMock).toHaveReceivedCommandTimes(ExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 5);
  });

  test('Created database, bi user, schemas and views in Redshift serverless - check status multiple times to wait with failure', async () => {
    ssmMock.onAnyCommand().resolves({});
    redshiftDataMock.on(ExecuteStatementCommand).resolves({ Id: 'Id-1' });
    redshiftDataMock.on(BatchExecuteStatementCommand).resolves({ Id: 'Id-2' });
    redshiftDataMock.on(DescribeStatementCommand)
      .resolvesOnce({ Status: 'FINISHED' }) // create db
      .resolvesOnce({ Status: 'FINISHED' }) // create bi user
      .resolvesOnce({ Status: 'STARTED' }) // create schemas
      .resolvesOnce({ Status: 'FAILED' }); // for second describe call while creating schema
    try {
      await handler(createServerlessEvent, context, callback);
    } catch (e) {
      expect(redshiftDataMock).toHaveReceivedCommandTimes(ExecuteStatementCommand, 2);
      expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 1);
      expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 4);
      return;
    }
    fail('No exception happened when Redshift DescribeStatementCommand returns FAILED');
  });

  test('Updated schemas and views only in Redshift serverless in update stack', async () => {
    ssmMock.onAnyCommand().resolves({});
    redshiftDataMock.on(BatchExecuteStatementCommand).callsFakeOnce(input => {
      if (input as BatchExecuteStatementCommandInput) {
        if (input.Sqls.length >= 2 && input.Sqls[0].includes('CREATE SCHEMA IF NOT EXISTS app2')
        && input.Sqls[1].includes(`CREATE TABLE IF NOT EXISTS app2.${TABLE_NAME_ODS_EVENT}(`)) {
          return { Id: 'Id-1' };
        }
      }
      throw new Error('Sqls are not expected');
    }).resolves({ Id: 'Id-2' });
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });
    const resp = await handler(updateServerlessEvent, context, callback) as CdkCustomResourceResponse;
    expect(resp.Status).toEqual('SUCCESS');
    expect(resp.Data?.RedshiftBIUsername).toEqual(`${biUserNamePrefix}abcde`);
    expect(ssmMock).toHaveReceivedCommandTimes(PutParameterCommand, 0);
    expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedNthSpecificCommandWith(1, BatchExecuteStatementCommand, {
      Sqls: expect.arrayContaining([
        `GRANT USAGE ON SCHEMA "app2" TO "${biUserNamePrefix}abcde";`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA "app2" TO "${biUserNamePrefix}abcde";`,
      ]),
    });
    expect(redshiftDataMock).toHaveReceivedNthSpecificCommandWith(1, BatchExecuteStatementCommand, {
      WorkgroupName: workgroupName,
      Database: projectDBName,
      ClusterIdentifier: undefined,
      DbUser: undefined,
    });
    expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 2);
  });

  test('Do nothing when deleting the stack', async () => {
    const deleteEvent: CdkCustomResourceEvent = {
      ...createServerlessEvent,
      PhysicalResourceId: 'id',
      RequestType: 'Delete',
    };
    const resp = await handler(deleteEvent, context, callback) as CdkCustomResourceResponse;
    expect(resp.Status).toEqual('SUCCESS');
    expect(ssmMock).toHaveReceivedCommandTimes(PutParameterCommand, 0);
    expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 0);
    expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 0);
  });

  test('Data api exception in Redshift serverless', async () => {
    ssmMock.onAnyCommand().resolves({});
    redshiftDataMock.on(ExecuteStatementCommand).resolves({ Id: 'Id-1' });
    redshiftDataMock.on(BatchExecuteStatementCommand).rejects();
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });
    try {
      await handler(createServerlessEvent, context, callback);
    } catch (e) {
      expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 1);
      expect(redshiftDataMock).toHaveReceivedCommandTimes(ExecuteStatementCommand, 2);
      expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 2);
      return;
    }
    fail('No exception happened when Redshift ExecuteStatementCommand failed');
  });

  test('Created database, bi user, schemas and views in Redshift provisioned cluster', async () => {
    ssmMock.onAnyCommand().resolves({});
    redshiftDataMock.on(ExecuteStatementCommand).resolves({ Id: 'Id-1' });
    redshiftDataMock.on(BatchExecuteStatementCommand).resolves({ Id: 'Id-2' });
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });
    const resp = await handler(createProvisionedEvent, context, callback) as CdkCustomResourceResponse;
    expect(resp.Status).toEqual('SUCCESS');
    expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedCommandTimes(ExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedNthSpecificCommandWith(1, ExecuteStatementCommand, {
      Sql: `CREATE DATABASE ${projectDBName};`,
      WorkgroupName: undefined,
      Database: defaultDBName,
      ClusterIdentifier: clusterId,
      DbUser: dbUser,
    });
    expect(redshiftDataMock).toHaveReceivedNthSpecificCommandWith(1, BatchExecuteStatementCommand, {
      WorkgroupName: undefined,
      Database: projectDBName,
      ClusterIdentifier: clusterId,
      DbUser: dbUser,
    });
    expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 4);
  });

  test('Updated schemas and views in Redshift provisioned cluster', async () => {
    redshiftDataMock
      .callsFakeOnce(input => {
        if (input as BatchExecuteStatementCommandInput) {
          if (input.Sqls.length >= 9 && input.Sqls[0].includes('CREATE SCHEMA IF NOT EXISTS app1')
          && input.Sqls[1].includes(`CREATE TABLE IF NOT EXISTS app1.${TABLE_NAME_ODS_EVENT}(`)
          && input.Sqls[8].includes('CREATE SCHEMA IF NOT EXISTS app2')) {
            return { Id: 'Id-1' };
          }
        }
        console.log(`Sql is ${input.Sqls}`);
        throw new Error('Sqls are not expected');
      }).resolves({ Id: 'Id-2' });
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });
    const resp = await handler(updateAdditionalProvisionedEvent, context, callback) as CdkCustomResourceResponse;
    expect(resp.Status).toEqual('SUCCESS');
    expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 2);
    expect(redshiftDataMock).toHaveReceivedNthSpecificCommandWith(1, BatchExecuteStatementCommand, {
      WorkgroupName: undefined,
      Database: projectDBName,
      ClusterIdentifier: clusterId,
      DbUser: dbUser,
    });
    expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 2);
  });

  test('Data api exception in Redshift provisioned cluster', async () => {
    ssmMock.onAnyCommand().resolves({});
    redshiftDataMock.on(ExecuteStatementCommand).resolves({ Id: 'Id-1' });
    redshiftDataMock.on(BatchExecuteStatementCommand).rejects();
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });
    try {
      await handler(createProvisionedEvent, context, callback);
    } catch (e) {
      expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 1);
      expect(redshiftDataMock).toHaveReceivedCommandTimes(ExecuteStatementCommand, 2);
      expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 2);
      return;
    }
    fail('No exception happened when Redshift ExecuteStatementCommand failed');
  });

  test('No valid Redshift cluster is specified', async () => {
    redshiftDataMock.on(BatchExecuteStatementCommand).resolves({ Id: 'Id-1' });
    redshiftDataMock.on(DescribeStatementCommand).resolves({ Status: 'FINISHED' });

    const invalidEvent = {
      ...basicEvent,
      ResourceProperties: {
        ...basicEvent.ResourceProperties,
        appIds: 'app1',
      },
    };
    try {
      await handler(invalidEvent, context, callback);
    } catch (e) {
      expect(redshiftDataMock).toHaveReceivedCommandTimes(BatchExecuteStatementCommand, 0);
      expect(redshiftDataMock).toHaveReceivedCommandTimes(DescribeStatementCommand, 0);
      return;
    }
    fail('No exception happened when Redshift ExecuteStatementCommand failed');
  });
});

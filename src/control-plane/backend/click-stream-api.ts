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

import path from 'path';
import {
  aws_dynamodb,
  aws_iam as iam,
  CfnResource,
  Duration,
  IgnoreMode,
  RemovalPolicy,
  Stack,
  Aws,
} from 'aws-cdk-lib';
import {
  EndpointType,
  RestApi,
  LambdaRestApi,
  MethodLoggingLevel,
  LogGroupLogDestination,
  AuthorizationType,
  IAuthorizer,
} from 'aws-cdk-lib/aws-apigateway';
import { AttributeType, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import {
  Connections,
  ISecurityGroup,
  Port,
  SecurityGroup,
  SubnetSelection,
  IVpc, SubnetType,
} from 'aws-cdk-lib/aws-ec2';
import { Architecture, DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { BatchInsertDDBCustomResource } from './batch-insert-ddb-custom-resource-construct';
import dictionary from './config/dictionary.json';
import { StackActionStateMachine } from './stack-action-state-machine-construct';
import { addCfnNagSuppressRules, addCfnNagToSecurityGroup } from '../../common/cfn-nag';
import { cloudWatchSendLogs, createENI } from '../../common/lambda';
import { createLogGroupWithKmsKey } from '../../common/logs';
import { POWERTOOLS_ENVS } from '../../common/powertools';

export interface DicItem {
  readonly name: string;
  readonly data: any;
}

export interface ApplicationLoadBalancerProps {
  readonly vpc: IVpc;
  readonly subnets: SubnetSelection;
  readonly securityGroup: ISecurityGroup;
}

export interface ApiGatewayProps {
  readonly stageName: string;
  readonly authorizer: IAuthorizer;
}

export interface ClickStreamApiProps {
  readonly fronting: 'alb' | 'cloudfront';
  readonly dictionaryItems?: DicItem[];
  readonly applicationLoadBalancer?: ApplicationLoadBalancerProps;
  readonly apiGateway?: ApiGatewayProps;
  readonly targetToCNRegions?: boolean;
  readonly s3MainRegion?: string;
}

export class ClickStreamApiConstruct extends Construct {
  public readonly clickStreamApiFunction: DockerImageFunction;
  public readonly lambdaRestApi?: RestApi;

  constructor(scope: Construct, id: string, props: ClickStreamApiProps) {
    super(scope, id);

    const dictionaryTable = new aws_dynamodb.Table(this, 'ClickstreamDictionary', {
      partitionKey: {
        name: 'name',
        type: aws_dynamodb.AttributeType.STRING,
      },
      billingMode: aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
      encryption: TableEncryption.AWS_MANAGED,
    });

    const clickStreamTable = new aws_dynamodb.Table(this, 'ClickstreamMetadata', {
      partitionKey: {
        name: 'id',
        type: aws_dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'type',
        type: aws_dynamodb.AttributeType.STRING,
      },
      billingMode: aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
      encryption: TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
    });
    const prefixTimeGSIName = 'prefix-time-index';
    clickStreamTable.addGlobalSecondaryIndex({
      indexName: prefixTimeGSIName,
      partitionKey: {
        name: 'prefix',
        type: AttributeType.STRING,
      },
      sortKey: {
        name: 'createAt',
        type: AttributeType.NUMBER,
      },
    });

    // Dictionary data init
    new BatchInsertDDBCustomResource(this, 'BatchInsertDDBCustomResource', {
      table: dictionaryTable,
      items: dictionary,
      targetToCNRegions: props.targetToCNRegions ?? false,
    });

    let apiFunctionProps = {};
    if (props.fronting === 'alb') {
      if (!props.applicationLoadBalancer) {
        throw new Error('Application Load Balancer fronting backend api must be have applicationLoadBalancer parameters.');
      }
      const apiLambdaSG = new SecurityGroup(this, 'ClickStreamApiFunctionSG', {
        vpc: props.applicationLoadBalancer.vpc,
        allowAllOutbound: true,
      });
      apiLambdaSG.connections.allowFrom(
        new Connections({
          securityGroups: [props.applicationLoadBalancer.securityGroup],
        }),
        Port.allTcp(),
        'allow all traffic from application load balancer',
      );
      addCfnNagToSecurityGroup(apiLambdaSG, ['W29', 'W27', 'W40', 'W5']);

      apiFunctionProps = {
        vpc: props.applicationLoadBalancer.vpc,
        vpcSubnets: [{ subnetType: SubnetType.PRIVATE_WITH_EGRESS }],
        securityGroups: [apiLambdaSG],
      };
    }

    // Create stack action StateMachine
    const stackActionStateMachine = new StackActionStateMachine(this, 'StackActionStateMachine', {
      clickStreamTable,
      lambdaFuncProps: apiFunctionProps,
      targetToCNRegions: props.targetToCNRegions ?? false,
    });

    // Create a role for lambda
    const clickStreamApiFunctionRole = new iam.Role(this, 'ClickStreamApiFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const stepFunctionPolicy = new iam.Policy(this, 'ClickStreamApiStepFunctionPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          resources: [stackActionStateMachine.stateMachine.stateMachineArn],
          actions: [
            'states:StartExecution',
          ],
        }),
      ],
    });
    stepFunctionPolicy.attachToRole(clickStreamApiFunctionRole);
    const awsSdkPolicy = new iam.Policy(this, 'ClickStreamApiAWSSdkPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          resources: ['*'],
          actions: [
            'kafka:ListClustersV2',
            'kafka:ListClusters',
            's3:ListAllMyBuckets',
            'ec2:DescribeVpcs',
            'redshift:DescribeClusters',
            'account:ListRegions',
            's3:ListBucket',
            'quicksight:ListUsers',
            'ec2:DescribeSubnets',
            'ec2:DescribeRouteTables',
            's3:GetBucketLocation',
            'route53:ListHostedZones',
            'athena:ListWorkGroups',
            'iam:ListRoles',
          ],
        }),
      ],
    });
    awsSdkPolicy.attachToRole(clickStreamApiFunctionRole);
    addCfnNagSuppressRules(awsSdkPolicy.node.defaultChild as iam.CfnPolicy, [
      {
        id: 'W12',
        reason:
          'The lambda need to be queried all resources under the current account by design',
      },
    ]);

    this.clickStreamApiFunction = new DockerImageFunction(this, 'ClickStreamApiFunction', {
      description: 'Lambda function for api of solution Click Stream Analytics on AWS',
      code: DockerImageCode.fromImageAsset(path.join(__dirname, './lambda/api'), {
        file: 'Dockerfile',
        ignoreMode: IgnoreMode.DOCKER,
      }),
      environment: {
        CLICK_STREAM_TABLE_NAME: clickStreamTable.tableName,
        DICTIONARY_TABLE_NAME: dictionaryTable.tableName,
        STACK_ACTION_SATE_MACHINE: stackActionStateMachine.stateMachine.stateMachineArn,
        PREFIX_TIME_GSI_NAME: prefixTimeGSIName,
        AWS_ACCOUNT_ID: Stack.of(this).account,
        AWS_URL_SUFFIX: Aws.URL_SUFFIX,
        S3_MAIN_REGION: props.s3MainRegion?? 'us-east-1',
        ... POWERTOOLS_ENVS,
      },
      architecture: Architecture.X86_64,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 3,
      memorySize: 512,
      role: clickStreamApiFunctionRole,
      ...apiFunctionProps,
    });

    dictionaryTable.grantReadWriteData(this.clickStreamApiFunction);
    clickStreamTable.grantReadWriteData(this.clickStreamApiFunction);
    cloudWatchSendLogs('api-func-logs', this.clickStreamApiFunction);
    createENI('api-func-eni', this.clickStreamApiFunction);

    if (props.fronting === 'cloudfront') {
      if (!props.apiGateway) {
        throw new Error('Cloudfront fronting backend api must be have Api Gateway parameters.');
      }

      const apiGatewayAccessLogGroup = createLogGroupWithKmsKey(this, {});

      this.lambdaRestApi = new LambdaRestApi(this, 'ClickStreamApi', {
        handler: this.clickStreamApiFunction,
        proxy: true,
        defaultMethodOptions: {
          authorizationType: AuthorizationType.CUSTOM,
          authorizer: props.apiGateway.authorizer,
        },
        endpointConfiguration: {
          types: [EndpointType.REGIONAL],
        },
        deployOptions: {
          stageName: props.apiGateway.stageName,
          tracingEnabled: true,
          dataTraceEnabled: false,
          loggingLevel: MethodLoggingLevel.ERROR,
          accessLogDestination: new LogGroupLogDestination(apiGatewayAccessLogGroup),
          metricsEnabled: true,
        },
      });
      // Configure Usage Plan
      this.lambdaRestApi.addUsagePlan('ClickStreamApiUsagePlan', {
        apiStages: [{
          api: this.lambdaRestApi,
          stage: this.lambdaRestApi.deploymentStage,
        }],
        throttle: {
          rateLimit: 50,
          burstLimit: 100,
        },
      });

      addCfnNagSuppressRules(
        this.clickStreamApiFunction.node.defaultChild as CfnResource,
        [
          {
            id: 'W89', //Lambda functions should be deployed inside a VPC
            reason: 'Lambda functions deployed outside VPC when cloudfront fronting backend api.',
          },
        ],
      );
      addCfnNagSuppressRules(
        stackActionStateMachine.callbackFunction.node.defaultChild as CfnResource,
        [
          {
            id: 'W89', //Lambda functions should be deployed inside a VPC
            reason: 'Lambda functions deployed outside VPC when cloudfront fronting backend api.',
          },
        ],
      );
    }
  }
}

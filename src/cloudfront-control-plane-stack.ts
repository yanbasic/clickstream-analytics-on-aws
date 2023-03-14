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

import { join } from 'path';
import { Stack, StackProps, CfnOutput, Fn, IAspect, CfnResource, Aspects, DockerImage } from 'aws-cdk-lib';
import { TokenAuthorizer } from 'aws-cdk-lib/aws-apigateway';
import { DnsValidatedCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  CfnDistribution,
  OriginProtocolPolicy,
  OriginRequestCookieBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
} from 'aws-cdk-lib/aws-cloudfront';
import { AddBehaviorOptions } from 'aws-cdk-lib/aws-cloudfront/lib/distribution';
import { Architecture, CfnFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Source } from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct, IConstruct } from 'constructs';
import {
  addCfnNagToStack,
  addCfnNagSuppressRules,
  addCfnNagForLogRetention,
  addCfnNagForCustomResourceProvider,
} from './common/cfn-nag';
import { Parameters } from './common/parameters';
import { POWERTOOLS_ENVS } from './common/powertools';
import { SolutionInfo } from './common/solution-info';
import { ClickStreamApiConstruct } from './control-plane/backend/click-stream-api';
import { CloudFrontS3Portal, DomainProps, CNCloudFrontS3PortalProps } from './control-plane/cloudfront-s3-portal';
import { Constant } from './control-plane/private/constant';
import {
  supressWarningsForCloudFrontS3Portal,
} from './control-plane/private/nag';
import { SolutionCognito } from './control-plane/private/solution-cognito';

export interface CloudFrontControlPlaneStackProps extends StackProps {
  /**
   * Indicate whether to create stack in CN regions
   *
   * @default - false.
   */
  targetToCNRegions?: boolean;

  /**
   * Whether to use custom domain name
   */
  useCustomDomainName?: boolean;

  /**
   * user existing OIDC provider or not
   */
  useExistingOIDCProvider?: boolean;
}

export class CloudFrontControlPlaneStack extends Stack {

  private paramGroups: any[] = [];
  private paramLabels: any = {};

  constructor(scope: Construct, id: string, props?: CloudFrontControlPlaneStackProps) {
    super(scope, id, props);

    this.templateOptions.description = SolutionInfo.DESCRIPTION + '- Control Plane';

    let domainProps: DomainProps | undefined = undefined;
    let cnCloudFrontS3PortalProps: CNCloudFrontS3PortalProps | undefined;

    if (props?.targetToCNRegions) {
      const iamCertificateId = Parameters.createIAMCertificateIdParameter(this);
      this.addToParamLabels('Certificate Id', iamCertificateId.logicalId);

      const domainName = Parameters.createDomainNameParameter(this);
      this.addToParamLabels('Domain Name', domainName.logicalId);

      cnCloudFrontS3PortalProps = {
        domainName: domainName.valueAsString,
        iamCertificateId: iamCertificateId.valueAsString,
      };

      Aspects.of(this).add(new InjectCustomResourceConfig('true'));

      this.addToParamGroups(
        'Domain Information',
        iamCertificateId.logicalId,
        domainName.logicalId,
      );

      new CfnOutput(this, 'CustomDomainName', {
        description: 'Custom domain name',
        value: domainName.valueAsString,
      }).overrideLogicalId('CustomDomainName');

    } else {
      if (props?.useCustomDomainName) {

        const domainParameters = Parameters.createDomainParameters(this, this.paramGroups, this.paramLabels);

        const hostedzone = HostedZone.fromHostedZoneAttributes(this, 'hostZone', {
          hostedZoneId: domainParameters.hostedZoneId.valueAsString,
          zoneName: domainParameters.hostedZoneName.valueAsString,
        });

        const certificate = new DnsValidatedCertificate(this, 'certificate', {
          domainName: Fn.join('.', [domainParameters.recordName.valueAsString, domainParameters.hostedZoneName.valueAsString]),
          hostedZone: hostedzone,
          region: 'us-east-1',
        });

        domainProps = {
          hostZone: hostedzone,
          recordName: domainParameters.recordName.valueAsString,
          certificate: certificate,
        };
      }
    }

    const controlPlane = new CloudFrontS3Portal(this, 'cloudfront_control_plane', {
      frontendProps: {
        assetPath: join(__dirname, '../frontend'),
        dockerImage: DockerImage.fromRegistry(Constant.NODE_IMAGE_V16),
        buildCommand: [
          'bash', '-c',
          'export APP_PATH=/tmp/app && mkdir $APP_PATH && cp -r `ls -A /asset-input | grep -v "node_modules" | grep -v "build"` $APP_PATH && cd $APP_PATH && npm install --loglevel error && npm run build --loglevel error && cp -r ./build/* /asset-output/',
        ],
        user: 'node',
        autoInvalidFilePaths: ['/index.html', '/asset-manifest.json', '/robots.txt', '/aws-exports.json', '/locales/*'],
      },
      cnCloudFrontS3PortalProps,
      domainProps,
      distributionProps: {
        logProps: {
          enableAccessLog: true,
        },
      },
    });

    let issuer: string;
    let clientId: string;
    //Create Cognito user pool and client for backend api
    if (!props?.useExistingOIDCProvider && !props?.targetToCNRegions) {
      const emailParamerter = Parameters.createCognitoUserEmailParameter(this);
      this.addToParamLabels('Admin User Email', emailParamerter.logicalId);
      this.addToParamGroups('Authentication Information', emailParamerter.logicalId);

      const cognito = new SolutionCognito(this, 'solution-cognito', {
        email: emailParamerter.valueAsString,
        callbackUrls: [controlPlane.controlPlaneUrl],
      });

      issuer = cognito.oidcProps.issuer;
      clientId = cognito.oidcProps.appClientId;

    } else {
      const oidcParameters = Parameters.createOIDCParameters(this, this.paramGroups, this.paramLabels);
      issuer = oidcParameters.oidcProvider.valueAsString;
      clientId = oidcParameters.oidcClientId.valueAsString;
    }

    const authFunction = new NodejsFunction(this, 'AuthorizerFunction', {
      runtime: props?.targetToCNRegions ? Runtime.NODEJS_16_X : Runtime.NODEJS_18_X,
      handler: 'handler',
      entry: './src/control-plane/auth/index.ts',
      environment: {
        JWKS_URI: issuer + '/.well-known/jwks.json',
        ISSUER: issuer,
        ... POWERTOOLS_ENVS,
      },
      architecture: Architecture.ARM_64,
      reservedConcurrentExecutions: 3,
      logRetention: RetentionDays.TEN_YEARS,
    });
    addCfnNagSuppressRules(
      authFunction.node.defaultChild as CfnFunction,
      [
        {
          id: 'W89', //Lambda functions should be deployed inside a VPC
          reason: Constant.NAG_REASON_NO_VPC_INVOLVED,
        },
      ],
    );

    const authorizer = new TokenAuthorizer(this, 'JWTAuthorizer', {
      handler: authFunction,
      validationRegex: '^(Bearer )[a-zA-Z0-9\-_]+?\.[a-zA-Z0-9\-_]+?\.([a-zA-Z0-9\-_]+)$',
    });

    const clickStreamApi = new ClickStreamApiConstruct(this, 'ClickStreamApi', {
      fronting: 'cloudfront',
      apiGateway: {
        stageName: 'api',
        authorizer: authorizer,
      },
      targetToCNRegions: props?.targetToCNRegions,
    });

    if (!clickStreamApi.lambdaRestApi) {
      throw new Error('Backend api create error.');
    }

    let behaviorOptions: AddBehaviorOptions = {};
    if (!props?.targetToCNRegions) {
      behaviorOptions = {
        originRequestPolicy: new OriginRequestPolicy(this, 'ApiGatewayOriginRequestPolicy', {
          comment: 'Policy to forward all parameters in viewer requests except for the Host header',
          cookieBehavior: OriginRequestCookieBehavior.all(),
          headerBehavior: {
            behavior: 'allExcept',
            headers: ['host'],
          },
          queryStringBehavior: OriginRequestQueryStringBehavior.all(),
        }),
      };
    }
    controlPlane.addHttpOrigin(
      `/${clickStreamApi.lambdaRestApi.deploymentStage.stageName}/*`,
      Fn.select(2, Fn.split('/', clickStreamApi.lambdaRestApi.url)),
      {
        protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
        originPath: `/${clickStreamApi.lambdaRestApi.deploymentStage.stageName}`,
      },
      behaviorOptions,
    );

    // upload config to S3
    const key = 'aws-exports.json';
    const awsExports = {
      oidc_provider: issuer,
      oidc_client_id: clientId,
      oidc_customer_domain: `${controlPlane.controlPlaneUrl}/signin`,
    };
    controlPlane.buckeyDeployment.addSource(Source.jsonData(key, awsExports));

    const portalDist = controlPlane.distribution.node.defaultChild as CfnDistribution;

    //This is a tricky to avoid 403 error when aceess paths except /index.html
    //TODO issue #17
    portalDist.addPropertyOverride(
      'DistributionConfig.CustomErrorResponses',
      [
        {
          ErrorCode: 403,
          ResponseCode: 200,
          ResponsePagePath: '/index.html',
        },
      ],
    );

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: this.paramGroups,
        ParameterLabels: this.paramLabels,
      },
    };

    //supress nag warnings
    supressWarningsForCloudFrontS3Portal(this);

    new CfnOutput(this, 'ControlPlaneUrl', {
      description: 'The CloudFront distribution domain name',
      value: controlPlane.controlPlaneUrl,
    }).overrideLogicalId('ControlPlaneUrl');

    new CfnOutput(this, 'PortalBucket', {
      description: 'Bucket to store the portal asset',
      value: controlPlane.bucket.bucketName,
    }).overrideLogicalId('PortalBucket');

    new CfnOutput(this, 'LogBucket', {
      description: 'Bucket to store access log',
      value: controlPlane.logBucket.bucketName,
    }).overrideLogicalId('LogBucket');

    // nag
    addCfnNag(this);
  }

  private addToParamGroups(label: string, ...param: string[]) {
    this.paramGroups.push({
      Label: { default: label },
      Parameters: param,
    });
  }

  private addToParamLabels(label: string, param: string) {
    this.paramLabels[param] = {
      default: label,
    };
  }
}

class InjectCustomResourceConfig implements IAspect {
  public constructor(private isInstallLatestAwsSdk: string) { }

  public visit(node: IConstruct): void {
    if (
      node instanceof CfnResource &&
      node.cfnResourceType === 'Custom::AWS'
    ) {
      node.addPropertyOverride('InstallLatestAwsSdk', this.isInstallLatestAwsSdk);
    }
  }
}

function addCfnNag(stack: Stack) {
  const cfnNagList = [
    {
      paths_endswith: [
        'ClickStreamApi/ApiGatewayAccessLogs/Resource',
      ],
      rules_to_suppress: [
        {
          id: 'W84',
          reason:
            'By default CloudWatchLogs LogGroups data is encrypted using the CloudWatch server-side encryption keys (AWS Managed Keys)',
        },
      ],
    },
  ];
  addCfnNagToStack(stack, cfnNagList);
  addCfnNagForLogRetention(stack);
  addCfnNagForCustomResourceProvider(stack, 'CDK built-in provider for DicInitCustomResourceProvider', 'DicInitCustomResourceProvider', undefined);
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'LogRetention lambda role which are created by CDK uses AWSLambdaBasicExecutionRole',
    },
    {
      id: 'AwsSolutions-L1',
      // The non-container Lambda function is not configured to use the latest runtime version
      reason:
        'The lambda is created by CDK, CustomResource framework-onEvent, the runtime version will be upgraded by CDK',
    },
  ]);
}



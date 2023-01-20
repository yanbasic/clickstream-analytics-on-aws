/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
  Certificate,
  CertificateValidation,
} from 'aws-cdk-lib/aws-certificatemanager';
import { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { RESOURCE_ID_PREFIX } from '../ingestion-server';

export function createCertificate(scope: Construct, hostedZone: IHostedZone, domainPrefix: string) {
  return new Certificate(scope, `${RESOURCE_ID_PREFIX}certificate`, {
    domainName: `${domainPrefix}.${hostedZone.zoneName}`,
    certificateName: 'ClickStream Ingestion Server Service',
    validation: CertificateValidation.fromDns(hostedZone),
  });
}

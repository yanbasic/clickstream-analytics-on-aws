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

package software.aws.solution.clickstream.transformer;

import lombok.Getter;
import lombok.Setter;
import lombok.ToString;
import software.aws.solution.clickstream.common.RuleConfig;

import java.io.Serializable;
import java.util.Map;

@Getter
@Setter
@ToString
public class TransformConfig implements Serializable {
    private static final long serialVersionUID = 1L;
    private Map<String, RuleConfig> appRuleConfig;
}

/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * <p>
 * Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 * with the License. A copy of the License is located at
 * <p>
 * http://www.apache.org/licenses/LICENSE-2.0
 * <p>
 * or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 * OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */

package software.aws.solution.clickstream.common.sensors.event;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Getter;
import lombok.Setter;

import java.util.HashMap;
import java.util.Map;

@Getter
@Setter
public class Lib {
    private final Map<String, Object> unknownProperties = new HashMap<>();

    @JsonProperty("lib_method")
    private String lib_method;

    @JsonProperty("lib")
    private String lib;

    @JsonProperty("lib_version")
    private String lib_version;

    @JsonProperty("app_version")
    private String app_version;

    @JsonProperty("lib_detail")
    private String lib_detail;

    @JsonAnySetter
    public void setUnknownProperty(final String name, final Object value) {
        unknownProperties.put(name, value);
    }

    @JsonAnyGetter
    public Map<String, Object> getUnknownProperties() {
        return unknownProperties;
    }
}

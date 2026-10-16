// SPDX-License-Identifier: Apache-2.0
// Lambda entry point used by template.yaml. Environment: TABLE, WS_ENDPOINT, PUBLIC_URL.
import { createPairingHandler } from './core.js';
import { createApiGatewayGateway, createDynamoStore } from './dynamo.js';

export const handler = createPairingHandler({
  store: createDynamoStore({ table: process.env.TABLE }),
  gateway: createApiGatewayGateway({ endpoint: process.env.WS_ENDPOINT }),
  publicUrl: process.env.PUBLIC_URL,
});

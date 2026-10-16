// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 vega-pair contributors
//
// DynamoDB store + API Gateway Management API gateway for core.js.
// Table layout (partition key `pk`, sort key `sk`, TTL attribute `expiresAt`):
//   S#<code> / META     session: the TV connection that owns the code
//   S#<code> / C#<id>   a connection in the session (role tv|phone)
//   C#<id>   / META     reverse lookup: which session a connection belongs to

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

const DAY_S = 24 * 60 * 60;

export function createDynamoStore({ table, client = DynamoDBDocumentClient.from(new DynamoDBClient({})), ttlSeconds = DAY_S }) {
  const expiresAt = () => Math.floor(Date.now() / 1000) + ttlSeconds;
  const put = (item, extra = {}) =>
    client.send(new PutCommand({ TableName: table, Item: { ...item, expiresAt: expiresAt() }, ...extra }));
  const del = (pk, sk) => client.send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));

  return {
    async claimSession(code, tvId) {
      try {
        await put({ pk: `S#${code}`, sk: 'META', tv: tvId }, { ConditionExpression: 'attribute_not_exists(pk)' });
        return true;
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    async sessionExists(code) {
      const { Item } = await client.send(new GetCommand({ TableName: table, Key: { pk: `S#${code}`, sk: 'META' } }));
      return Boolean(Item);
    },
    async addConnection(id, code, role) {
      await Promise.all([put({ pk: `C#${id}`, sk: 'META', code, role }), put({ pk: `S#${code}`, sk: `C#${id}`, role })]);
    },
    async getConnection(id) {
      const { Item } = await client.send(new GetCommand({ TableName: table, Key: { pk: `C#${id}`, sk: 'META' } }));
      return Item ? { code: Item.code, role: Item.role } : null;
    },
    async sessionConnections(code) {
      const { Items = [] } = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :c)',
          ExpressionAttributeValues: { ':pk': `S#${code}`, ':c': 'C#' },
        }),
      );
      return Items.map((i) => ({ id: i.sk.slice(2), role: i.role }));
    },
    async removeConnection(code, id) {
      await Promise.all([del(`C#${id}`, 'META'), del(`S#${code}`, `C#${id}`)]);
    },
    async deleteSession(code) {
      await del(`S#${code}`, 'META');
    },
  };
}

export function createApiGatewayGateway({ endpoint, client = new ApiGatewayManagementApiClient({ endpoint }) }) {
  return {
    async post(id, msg) {
      try {
        await client.send(new PostToConnectionCommand({ ConnectionId: id, Data: `${JSON.stringify(msg)}\n` }));
        return true;
      } catch (err) {
        if (err.name === 'GoneException' || err.$metadata?.httpStatusCode === 410) return false;
        throw err;
      }
    },
    async disconnect(id) {
      try {
        await client.send(new DeleteConnectionCommand({ ConnectionId: id }));
      } catch {}
    },
  };
}

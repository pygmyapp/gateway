import { Epoch, Snowyflake } from 'snowyflake';

const snowyflake = new Snowyflake({
  workerId: 1n,
  epoch: Epoch.Twitter
});

export const generateSnowflake = () => snowyflake.nextId().toString();

export const parseSnowflake = (id: bigint | string) =>
  snowyflake.deconstruct(BigInt(id));

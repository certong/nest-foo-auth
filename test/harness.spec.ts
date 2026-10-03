import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';

@Injectable()
class Dependency {
  value(): string {
    return 'resolved';
  }
}

@Injectable()
class Consumer {
  constructor(private readonly dependency: Dependency) {}
  read(): string {
    return this.dependency.value();
  }
}

describe('test harness', () => {
  it('resolves a constructor-injected provider, proving decorator metadata survives the transform', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [Dependency, Consumer],
    }).compile();

    expect(moduleRef.get(Consumer).read()).toBe('resolved');
  });
});

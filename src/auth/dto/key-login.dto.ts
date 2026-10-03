import { IsString, Matches } from 'class-validator';

export class KeyLoginDto {
  /**
   * Exactly six digits, and nothing else on the object: the global pipe runs
   * with whitelist and forbidNonWhitelisted, so declaring only this field is
   * what stops a caller smuggling an `email` alongside the key and turning a
   * credential that deliberately carries no identity into one that does.
   *
   * The pattern is also the 400 the frontend expects for a malformed key — a
   * screen that can only produce six digits should never reach the hashing path,
   * and a caller that is not the screen should not get to choose the input size.
   */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'key must be exactly six digits' })
  key!: string;
}

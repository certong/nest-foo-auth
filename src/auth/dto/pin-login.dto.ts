import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';

export class PinLoginDto {
  /**
   * Lowercased and trimmed exactly like LoginDto, so the account lookup and the
   * lockout both key on one spelling of an address. Without it, `A@x.com` and
   * `a@x.com` would each get five tries.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  /**
   * Exactly six digits. A screen that can only produce six digits should never
   * reach the hashing path with anything else, and a caller that is not the
   * screen should not get to choose the input size.
   */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'pin must be exactly six digits' })
  pin!: string;
}

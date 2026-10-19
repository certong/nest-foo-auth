import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export class PinLoginDto {
  /**
   * Lowercased and trimmed exactly like LoginDto, so the account lookup and the
   * lockout both key on one spelling of an address. Without it, `A@x.com` and
   * `a@x.com` would each get five tries.
   *
   * Optional since FA-25, and the portal decides whether its absence is
   * allowed — which is a decision this DTO cannot make, because validation runs
   * before the controller and `Origin` has not been read into a portal yet.
   * Studio requires it and AuthService refuses the request without it; billing
   * is single-operator and does not ask for it at all.
   *
   * `ValidateIf`, deliberately, and not `IsOptional` — which skips null as well
   * as undefined. Omitting the key is the only way to leave the email out: an
   * empty string or a null is a malformed address rather than an absent one,
   * and accepting either as "not given" would let a caller drop the email by
   * sending a blank one.
   */
  @ValidateIf((dto: PinLoginDto) => dto.email !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email?: string;

  /**
   * Exactly six digits. A screen that can only produce six digits should never
   * reach the hashing path with anything else, and a caller that is not the
   * screen should not get to choose the input size.
   */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'pin must be exactly six digits' })
  pin!: string;
}

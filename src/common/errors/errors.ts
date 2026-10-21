import { HttpStatus } from '@nestjs/common';
import { AppException } from './app.exception.js';
import { ErrorCode } from './error-code.js';
import type { OwnedChannel } from './errors.types.js';
import type { ErrorDetail } from './errors.types.js';

/**
 * CATALOG LỖI — mọi `AppException` trong `src/` được tạo ở đây, và chỉ ở đây
 * (test kiến trúc `test/unit/architecture/errors-catalog.spec.ts` canh điều này).
 *
 * - Mỗi mục là một HÀM, không phải hằng: mỗi lần `throw` cần instance mới (stack trace đúng chỗ
 *   ném), và vài lỗi có tham số (`details`).
 * - Tra theo TÌNH HUỐNG, không theo `code`: `NOT_FOUND` / `FORBIDDEN` là một code nhưng nhiều
 *   thông điệp (không tìm thấy kênh / tổ chức / …).
 * - Client dựa vào `code`; `message` dành cho người đọc. Sửa câu chữ ở đây không làm vỡ client.
 *   Sau này cần đa ngôn ngữ thì chỉ phải đổi file này (message → key i18n).
 *
 * Dùng: `throw Errors.channel.archived();`
 */

const badRequest = (code: ErrorCode, message: string, details?: ErrorDetail[]) =>
  new AppException(code, HttpStatus.BAD_REQUEST, message, details);
const unauthorized = (code: ErrorCode, message: string) =>
  new AppException(code, HttpStatus.UNAUTHORIZED, message);
const forbidden = (message: string) =>
  new AppException(ErrorCode.Forbidden, HttpStatus.FORBIDDEN, message);
const notFound = (message: string, code: ErrorCode = ErrorCode.NotFound) =>
  new AppException(code, HttpStatus.NOT_FOUND, message);
const conflict = (code: ErrorCode, message: string, details?: ErrorDetail[]) =>
  new AppException(code, HttpStatus.CONFLICT, message, details);
const gone = (code: ErrorCode, message: string) => new AppException(code, HttpStatus.GONE, message);

const ownedChannelDetails = (channels: OwnedChannel[]) =>
  channels.map((c) => ({ field: `channels.${c.id}`, message: c.name }));

export const Errors = {
  common: {
    validationFailed: (details: ErrorDetail[]) =>
      badRequest(ErrorCode.ValidationFailed, 'Dữ liệu gửi lên không hợp lệ.', details),
    invalidCursor: () => badRequest(ErrorCode.InvalidCursor, 'Cursor không hợp lệ.'),
    // Ba lỗi dưới do `AllExceptionsFilter` dùng cho lỗi KHÔNG phải AppException lọt tới nó
    // (vi phạm ràng buộc DB chưa được service map sang mã cụ thể, lỗi ngoài dự kiến).
    duplicate: () => conflict(ErrorCode.Conflict, 'Dữ liệu đã tồn tại.'),
    referenceInvalid: () =>
      conflict(ErrorCode.Conflict, 'Dữ liệu tham chiếu không hợp lệ hoặc đang được sử dụng.'),
    /** Không lộ stack / SQL cho client; chi tiết nằm trong log server. */
    internal: () =>
      new AppException(
        ErrorCode.InternalError,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Đã có lỗi xảy ra. Vui lòng thử lại sau.',
      ),
  },

  /** Kiểm tra theo đối tượng, dùng chung cho tổ chức và kênh. */
  role: {
    /** "Không ai tác động lên người có vai trò ≥ mình" (04-authorization). */
    cannotActOn: () => forbidden('Bạn không được tác động lên thành viên có vai trò này.'),
    /** "Không ai cấp vai trò ngang hoặc cao hơn mình": link mời, duyệt yêu cầu, thêm vào kênh. */
    cannotGrant: () => forbidden('Bạn không thể cấp vai trò ngang hoặc cao hơn vai trò của mình.'),
  },

  auth: {
    emailTaken: () => conflict(ErrorCode.AuthEmailTaken, 'Email này đã được sử dụng.'),
    // Cùng một câu cho "sai email" và "sai mật khẩu": không cho dò email nào đã đăng ký.
    invalidCredentials: () =>
      unauthorized(ErrorCode.AuthInvalidCredentials, 'Email hoặc mật khẩu không đúng.'),
    tokenMissing: () =>
      unauthorized(ErrorCode.AuthTokenMissing, 'Thiếu access token (Authorization: Bearer …).'),
    tokenExpired: () =>
      unauthorized(ErrorCode.AuthTokenExpired, 'Access token đã hết hạn. Hãy refresh.'),
    tokenInvalid: () => unauthorized(ErrorCode.AuthTokenInvalid, 'Access token không hợp lệ.'),
    sessionRevoked: () =>
      unauthorized(ErrorCode.AuthSessionRevoked, 'Phiên đăng nhập đã bị thu hồi.'),
    refreshTokenRotated: () =>
      unauthorized(
        ErrorCode.AuthRefreshTokenRotated,
        'Refresh token vừa được đổi. Hãy dùng token mới nhất.',
      ),
    refreshTokenReused: () =>
      unauthorized(
        ErrorCode.AuthRefreshTokenReused,
        'Refresh token đã bị dùng lại. Phiên đăng nhập đã bị thu hồi, vui lòng đăng nhập lại.',
      ),
    refreshTokenInvalid: () =>
      unauthorized(
        ErrorCode.AuthRefreshTokenInvalid,
        'Refresh token không hợp lệ hoặc đã hết hạn.',
      ),
  },

  user: {
    notFound: () => notFound('Không tìm thấy người dùng.'),
    sessionNotFound: () => notFound('Không tìm thấy phiên đăng nhập.'),
  },

  org: {
    /** Không tồn tại, đã xoá, HOẶC người gọi không phải thành viên — một câu cho cả ba. */
    notFound: () => notFound('Không tìm thấy tổ chức.'),
    memberNotFound: () => notFound('Người này không phải thành viên tổ chức.'),
    forbidden: () => forbidden('Vai trò của bạn trong tổ chức không được phép làm việc này.'),
    ownerImmutable: () =>
      conflict(
        ErrorCode.OrgOwnerImmutable,
        'Không thể đổi vai trò hoặc gỡ Owner. Hãy chuyển quyền sở hữu trước.',
      ),
    ownerMustTransfer: () =>
      conflict(
        ErrorCode.OrgOwnerMustTransfer,
        'Owner phải chuyển quyền sở hữu trước khi rời tổ chức.',
      ),
    transferToSelf: () =>
      conflict(ErrorCode.OrgTransferInvalidTarget, 'Bạn đã là Owner của tổ chức này.'),
    noLongerOwner: () => forbidden('Bạn không còn là Owner của tổ chức này.'),
    alreadyMember: () =>
      conflict(ErrorCode.OrgAlreadyMember, 'Bạn đã là thành viên của tổ chức này.'),
    /**
     * Rời / bị gỡ khỏi org khi còn làm chủ kênh (M4 Q3). `details[i].field = channels.<id>`,
     * `message` = tên kênh, để client dẫn thẳng tới màn chuyển chủ kênh.
     */
    leaverOwnsChannels: (channels: OwnedChannel[]) =>
      conflict(
        ErrorCode.OrgMemberOwnsChannels,
        `Bạn đang làm chủ ${channels.length} kênh. Hãy chuyển chủ kênh trước khi rời tổ chức.`,
        ownedChannelDetails(channels),
      ),
    targetOwnsChannels: (channels: OwnedChannel[]) =>
      conflict(
        ErrorCode.OrgMemberOwnsChannels,
        `Người này đang làm chủ ${channels.length} kênh. Hãy chuyển chủ các kênh đó trước khi gỡ.`,
        ownedChannelDetails(channels),
      ),
  },

  invite: {
    /** Admin thao tác trên link theo id (thu hồi) — `NOT_FOUND` chung. */
    notFound: () => notFound('Không tìm thấy link mời.'),
    /** Người dùng mở link theo TOKEN — mã riêng để client hiện màn "link không tồn tại". */
    tokenNotFound: () => notFound('Không tìm thấy link mời.', ErrorCode.InviteNotFound),
    expired: () => gone(ErrorCode.InviteExpired, 'Link mời đã hết hạn.'),
    exhausted: () => gone(ErrorCode.InviteExhausted, 'Link mời đã hết lượt.'),
  },

  joinRequest: {
    notFound: () => notFound('Không tìm thấy yêu cầu tham gia.'),
    pending: () =>
      conflict(ErrorCode.OrgJoinRequestPending, 'Bạn đã có một yêu cầu tham gia đang chờ duyệt.'),
    notPending: () => conflict(ErrorCode.JoinRequestNotPending, 'Yêu cầu này đã được xử lý.'),
  },

  upload: {
    /** Không tồn tại, của người khác, hoặc khác tổ chức — một câu cho cả ba (tài nguyên ẩn). */
    notFound: () => notFound('Không tìm thấy upload.'),
    expired: () => gone(ErrorCode.UploadExpired, 'Upload đã hết hạn. Hãy bắt đầu upload mới.'),
    partOutOfRange: (totalParts: number) =>
      badRequest(ErrorCode.UploadPartOutOfRange, `Số phần phải từ 1 đến ${totalParts}.`),
    partSizeMismatch: (expected: number, actual: number) =>
      badRequest(
        ErrorCode.UploadPartSizeMismatch,
        `Phần này phải đúng ${expected} byte, nhận Content-Length ${actual}.`,
      ),
    /** Trả TRƯỚC khi đọc body: không tốn băng thông nhận một phần quá cỡ rồi mới từ chối. */
    partTooLarge: (expected: number) =>
      new AppException(
        ErrorCode.PayloadTooLarge,
        HttpStatus.PAYLOAD_TOO_LARGE,
        `Phần này tối đa ${expected} byte.`,
      ),
    lengthRequired: () =>
      new AppException(
        ErrorCode.LengthRequired,
        HttpStatus.LENGTH_REQUIRED,
        'Cần header Content-Length đúng kích thước phần (không nhận Transfer-Encoding: chunked).',
      ),
    unsupportedMediaType: () =>
      new AppException(
        ErrorCode.UnsupportedMediaType,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'Body của phần phải là application/octet-stream.',
      ),
    /** Complete khi còn thiếu phần; `details` liệt kê số phần thiếu để client gửi tiếp. */
    incomplete: (missing: number[]) =>
      conflict(
        ErrorCode.UploadIncomplete,
        `Còn thiếu ${missing.length} phần. Hãy gửi đủ rồi complete lại.`,
        missing.map((n) => ({ field: `parts.${n}`, message: 'chưa nhận' })),
      ),
    /** Client ngắt giữa chừng. Client không nhận được câu này; mục đích là log 4xx thay vì 5xx. */
    partAborted: () =>
      badRequest(ErrorCode.UploadPartAborted, 'Kết nối bị ngắt giữa chừng. Hãy gửi lại phần này.'),
    /** Upload đã xong / đã huỷ / đã hết hạn nên không làm thao tác này được nữa. */
    notActive: () =>
      conflict(ErrorCode.UploadNotActive, 'Upload không còn ở trạng thái nhận dữ liệu.'),
  },

  /** Header `Idempotency-Key` (`@Idempotent()`), dùng chung cho mọi route. */
  idempotency: {
    invalidKey: () =>
      badRequest(ErrorCode.ValidationFailed, 'Header Idempotency-Key không hợp lệ.', [
        {
          field: 'headers.idempotency-key',
          message: '1–255 ký tự ASCII in được, không có khoảng trắng',
        },
      ]),
    /** Cùng key nhưng method / path / body khác lần đầu — lỗi của client, gửi lại cũng vô ích. */
    reused: () =>
      new AppException(
        ErrorCode.IdempotencyKeyReused,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Idempotency-Key này đã dùng cho một request khác. Mỗi thao tác mới cần một key mới.',
      ),
    /** Request đầu với key này chưa xong — thử lại sau sẽ nhận đúng response của nó. */
    inProgress: () =>
      conflict(
        ErrorCode.IdempotencyInProgress,
        'Request trước với Idempotency-Key này đang được xử lý. Hãy thử lại sau giây lát.',
      ),
  },

  notification: {
    /** Không tồn tại hoặc của người khác — một câu cho cả hai (tài nguyên ẩn). */
    notFound: () => notFound('Không tìm thấy thông báo.'),
  },

  meeting: {
    /** Không tồn tại / không có quyền xem / khác tổ chức — một câu (tài nguyên ẩn). */
    notFound: () => notFound('Không tìm thấy cuộc họp.'),
    /** Xem được nhưng không phải chủ (và không phải OrgAdm với meeting không chủ). */
    notManager: () =>
      forbidden(
        'Chỉ chủ cuộc họp được làm việc này (cuộc họp không còn chủ: Owner / Admin tổ chức).',
      ),
  },

  channel: {
    /** Không tồn tại, đã xoá, HOẶC riêng tư mà người gọi không được thấy — không lộ khác biệt. */
    notFound: () => notFound('Không tìm thấy kênh.'),
    forbidden: () => forbidden('Vai trò của bạn trong kênh không được phép làm việc này.'),
    nameTaken: () => conflict(ErrorCode.ChannelNameTaken, 'Tổ chức đã có kênh trùng tên.'),
    archived: () => conflict(ErrorCode.ChannelArchived, 'Kênh đã được lưu trữ (chỉ đọc).'),
    memberNotFound: () => notFound('Không tìm thấy thành viên kênh.'),
    alreadyMember: () => conflict(ErrorCode.ChannelAlreadyMember, 'Người này đã ở trong kênh.'),
    alreadyJoined: () => conflict(ErrorCode.ChannelAlreadyMember, 'Bạn đã ở trong kênh này.'),
    ownerMustTransfer: () =>
      conflict(
        ErrorCode.ChannelOwnerMustTransfer,
        'Chủ kênh phải chuyển chủ kênh cho người khác trước khi rời kênh.',
      ),
    transferToCurrentOwner: () =>
      conflict(ErrorCode.ChannelTransferInvalidTarget, 'Người này đã là Chủ kênh.'),
    transferToGuest: () =>
      conflict(
        ErrorCode.ChannelTransferInvalidTarget,
        'Khách không thể làm Chủ kênh. Hãy đổi vai trò người này trước.',
      ),
    ownerImmutable: () =>
      conflict(
        ErrorCode.ChannelOwnerImmutable,
        'Không thể đổi vai trò hoặc gỡ Chủ kênh. Hãy chuyển chủ kênh trước.',
      ),
  },
} as const;

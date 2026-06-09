import { Icon } from "../../components/ui/icon";
import { Modal } from "../../components/ui/modal";

export function DedupPreviewModal({
  image,
  onClose,
}: {
  image: string | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={Boolean(image)}
      onClose={onClose}
      accessibleTitle="重复文件预览"
      className="max-w-5xl overflow-hidden bg-slate-950"
    >
      <div className="relative flex max-h-[88vh] items-center justify-center bg-slate-950 p-5">
        {image && <img src={image} alt="预览" className="max-h-[80vh] max-w-full rounded-[10px] object-contain" />}
        <button
          className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-700 transition hover:bg-white"
          onClick={onClose}
          aria-label="关闭预览"
        >
          <Icon name="close" size={18} />
        </button>
      </div>
    </Modal>
  );
}

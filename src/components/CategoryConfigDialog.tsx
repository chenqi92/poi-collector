import { useState, useEffect } from 'react';
import { Settings2, Check } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface Category {
    id: string;
    name: string;
    keywords: string[];
}

interface CategoryConfigDialogProps {
    open: boolean;
    platformName: string;
    categories: Category[];
    selectedCategories: string[];
    onClose: () => void;
    onChange: (categoryIds: string[]) => void;
}

export function CategoryConfigDialog({
    open,
    platformName,
    categories,
    selectedCategories,
    onClose,
    onChange,
}: CategoryConfigDialogProps) {
    // 本地状态用于编辑，关闭时提交
    const [localSelected, setLocalSelected] = useState<string[]>([]);

    useEffect(() => {
        if (open) {
            setLocalSelected([...selectedCategories]);
        }
    }, [open, selectedCategories]);

    const toggleCategory = (categoryId: string) => {
        setLocalSelected(prev =>
            prev.includes(categoryId)
                ? prev.filter(id => id !== categoryId)
                : [...prev, categoryId]
        );
    };

    const toggleAll = (selectAll: boolean) => {
        setLocalSelected(selectAll ? categories.map(c => c.id) : []);
    };

    const handleConfirm = () => {
        onChange(localSelected);
        onClose();
    };

    const isAllSelected = localSelected.length === categories.length;

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Settings2 className="w-5 h-5" />
                        {platformName} 类别配置
                    </DialogTitle>
                    <DialogDescription>
                        选择要采集的 POI 类别（已选 {localSelected.length}/{categories.length}）
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    {/* 全选控制 */}
                    <div className="flex items-center justify-between px-1">
                        <span className="text-sm text-muted-foreground">快捷操作</span>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                                type="checkbox"
                                checked={isAllSelected}
                                onChange={(e) => toggleAll(e.target.checked)}
                                className="rounded border-primary"
                            />
                            全选
                        </label>
                    </div>

                    {/* 类别列表 */}
                    <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto p-1">
                        {categories.map((cat) => {
                            const isSelected = localSelected.includes(cat.id);
                            return (
                                <button
                                    key={cat.id}
                                    onClick={() => toggleCategory(cat.id)}
                                    className={`
                                        relative flex items-center justify-center px-3 py-2 rounded-lg text-sm
                                        transition-all duration-200 border
                                        ${isSelected
                                            ? 'bg-primary/10 text-primary border-primary/40 shadow-sm'
                                            : 'bg-muted/50 text-muted-foreground border-transparent hover:border-primary/30 hover:bg-muted'
                                        }
                                    `}
                                >
                                    {isSelected && (
                                        <Check className="w-3 h-3 absolute top-1 right-1 text-primary" />
                                    )}
                                    {cat.name}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        取消
                    </Button>
                    <Button onClick={handleConfirm}>
                        确认
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
